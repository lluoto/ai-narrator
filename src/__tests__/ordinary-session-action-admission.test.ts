import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ServerWebSocket } from "bun";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { createWsClient, removeWsClient, type WsConnectionData } from "../api/ws-handler";
import { LLMClient } from "../llm/client";
import { OrdinaryActionAdmissionCoordinator } from "../api/ordinary-action-admission";
import { Database } from "bun:sqlite";

const OWNER = "keeper:ordinary-action-admission";
const CONFIG = {
  apiKey: "sk-ordinary-action-admission-key",
  baseUrl: "http://ordinary-action-admission.invalid/v1",
  model: "ordinary-action-admission-model",
  maxTokens: 32,
  temperature: 0,
};
const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
const liveSockets: Array<ServerWebSocket<WsConnectionData>> = [];
let savedFetch: typeof fetch;
const processChild = join(import.meta.dir, "ordinary-session-action-admission-child.ts");

type ProcessEvent = Record<string, unknown> & { event: string };
type ProcessHandle = Pick<Bun.Subprocess<"pipe", "pipe", "pipe">,
  "stdout" | "stderr" | "stdin" | "exited" | "signalCode" | "kill">;

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 15_000);
  });
  return Promise.race([promise, expiry]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
}

function spawnHoldingProcess(root: string, sessionId: string, injectedHandle?: ProcessHandle) {
  const processHandle = injectedHandle ?? Bun.spawn([process.execPath, processChild, "hold", root, sessionId], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const events: ProcessEvent[] = []; let wake: (() => void) | undefined;
  let stdout = ""; let stderr = ""; let pending = "";
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of processHandle.stdout) {
      const text = decoder.decode(chunk, { stream: true }); stdout += text; pending += text;
      for (;;) {
        const end = pending.indexOf("\n"); if (end < 0) break;
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line.startsWith("@@ordinary-action-admission@@")) continue;
        events.push(JSON.parse(line.slice("@@ordinary-action-admission@@".length)) as ProcessEvent);
        wake?.(); wake = undefined;
      }
    }
  })();
  const stderrDrain = (async () => { stderr = await new Response(processHandle.stderr).text(); })();
  let released = false;
  const next = async (): Promise<ProcessEvent> => {
    while (!events.length) {
      const exited = await Promise.race([
        new Promise<"event">((resolve) => { wake = () => resolve("event"); }),
        processHandle.exited.then(() => "exit" as const),
      ]);
      if (exited === "exit" && !events.length) {
        await Promise.all([stdoutDrain, stderrDrain]);
        // Exit notification can precede the final stdout chunk being parsed.
        if (!events.length) {
          const code = await processHandle.exited;
          throw new Error(`ordinary admission hold child exited before event (code=${code}, signal=${processHandle.signalCode}): ${stdout}\n${stderr}`);
        }
      }
    }
    return events.shift()!;
  };
  return {
    next: () => within(next(), "ordinary admission child event"),
    release() {
      if (released) return; released = true;
      const stdin = processHandle.stdin;
      if (!stdin || typeof stdin === "number") throw new Error("ordinary admission hold child stdin is unavailable");
      stdin.write("release\n"); stdin.end();
    },
    async finish() {
      const event = await within(next(), "ordinary admission hold result");
      const code = await within(processHandle.exited, "ordinary admission hold child exit");
      await within(Promise.all([stdoutDrain, stderrDrain]), "ordinary admission hold child drain");
      if (code !== 0) throw new Error(`ordinary admission hold child failed (code=${code}, signal=${processHandle.signalCode}): ${stdout}\n${stderr}`);
      return event;
    },
    async dispose() {
      try { this.release(); } catch { /* child may already have closed stdin */ }
      try { await within(processHandle.exited, "ordinary admission hold cleanup"); }
      catch { try { processHandle.kill(); } catch { /* already exited */ } }
      try { await Promise.all([stdoutDrain, stderrDrain]); } catch { /* failure is reported by the test path */ }
    },
  };
}

function spawnRaceProcess(root: string, sessionId: string, label: string, injectedHandle?: ProcessHandle) {
  const processHandle = injectedHandle ?? Bun.spawn([process.execPath, processChild, "race", root, sessionId, label], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const events: ProcessEvent[] = []; let wake: (() => void) | undefined;
  let stdout = ""; let stderr = ""; let pending = ""; let closed = false;
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of processHandle.stdout) {
      const text = decoder.decode(chunk, { stream: true }); stdout += text; pending += text;
      for (;;) {
        const end = pending.indexOf("\n"); if (end < 0) break;
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line.startsWith("@@ordinary-action-admission@@")) continue;
        events.push(JSON.parse(line.slice("@@ordinary-action-admission@@".length)) as ProcessEvent);
        wake?.(); wake = undefined;
      }
    }
  })();
  const stderrDrain = (async () => { stderr = await new Response(processHandle.stderr).text(); })();
  const next = async (): Promise<ProcessEvent> => {
    while (!events.length) {
      const state = await Promise.race([
        new Promise<"event">((resolve) => { wake = () => resolve("event"); }),
        processHandle.exited.then(() => "exit" as const),
      ]);
      if (state === "exit" && !events.length) {
        await Promise.all([stdoutDrain, stderrDrain]);
        if (!events.length) {
          const code = await processHandle.exited;
          throw new Error(`ordinary admission race child exited before event (code=${code}, signal=${processHandle.signalCode}): ${stdout}\n${stderr}`);
        }
      }
    }
    return events.shift()!;
  };
  const signal = async (value: "go" | "release", end = false) => {
    if (closed) return;
    const stdin = processHandle.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("ordinary admission race child stdin is unavailable");
    stdin.write(`${value}\n`);
    await stdin.flush();
    if (end) { closed = true; stdin.end(); }
  };
  return {
    async next() {
      try { return await within(next(), `ordinary admission race ${label} event`); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout=${stdout}\nstderr=${stderr}`); }
    },
    start: () => signal("go"),
    release: () => signal("release", true),
    async finish() {
      const code = await within(processHandle.exited, `ordinary admission race ${label} exit`);
      await within(Promise.all([stdoutDrain, stderrDrain]), `ordinary admission race ${label} drain`);
      if (code !== 0) throw new Error(`ordinary admission race ${label} failed (code=${code}, signal=${processHandle.signalCode}): ${stdout}\n${stderr}`);
    },
    async dispose() {
      try { await signal("release", true); } catch { /* child may already have closed stdin */ }
      try { await within(processHandle.exited, `ordinary admission race ${label} cleanup`); }
      catch { try { processHandle.kill(); } catch { /* already exited */ } }
      try { await Promise.all([stdoutDrain, stderrDrain]); } catch { /* primary test reports protocol failure */ }
    },
  };
}

function spawnCrashLeaseProcess(root: string, sessionId: string, injectedHandle?: ProcessHandle) {
  const processHandle = injectedHandle ?? Bun.spawn([process.execPath, processChild, "lease-hold", root, sessionId], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const events: ProcessEvent[] = []; let wake: (() => void) | undefined;
  let stdout = ""; let stderr = ""; let pending = ""; let killed = false;
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of processHandle.stdout) {
      const text = decoder.decode(chunk, { stream: true }); stdout += text; pending += text;
      for (;;) {
        const end = pending.indexOf("\n"); if (end < 0) break;
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line.startsWith("@@ordinary-action-admission@@")) continue;
        events.push(JSON.parse(line.slice("@@ordinary-action-admission@@".length)) as ProcessEvent);
        wake?.(); wake = undefined;
      }
    }
  })();
  const stderrDrain = (async () => { stderr = await new Response(processHandle.stderr).text(); })();
  const next = async (): Promise<ProcessEvent> => {
    while (!events.length) {
      const state = await Promise.race([
        new Promise<"event">((resolve) => { wake = () => resolve("event"); }),
        processHandle.exited.then(() => "exit" as const),
      ]);
      if (state === "exit" && !events.length) {
        await Promise.all([stdoutDrain, stderrDrain]);
        if (!events.length) {
          const code = await processHandle.exited;
          throw new Error(`ordinary admission crash child exited before event (code=${code}, signal=${processHandle.signalCode}): ${stdout}\n${stderr}`);
        }
      }
    }
    return events.shift()!;
  };
  return {
    next: () => within(next(), "ordinary admission crash child event"),
    async killAndDrain() {
      if (!killed) { killed = true; processHandle.kill(); }
      await within(processHandle.exited, "ordinary admission crash child exit");
      await within(Promise.all([stdoutDrain, stderrDrain]), "ordinary admission crash child drain");
    },
    async dispose() {
      try { await this.killAndDrain(); }
      catch { /* no other process is ever targeted by this cleanup */ }
    },
  };
}

function runAdvancingProcessSynchronously(root: string, sessionId: string): ProcessEvent {
  const result = Bun.spawnSync([process.execPath, processChild, "advance", root, sessionId], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith("@@ordinary-action-admission@@"));
  if (result.exitCode !== 0 || !line) {
    throw new Error(`ordinary admission advance child failed (${result.exitCode}): ${stdout}\n${stderr}`);
  }
  return JSON.parse(line.slice("@@ordinary-action-admission@@".length)) as ProcessEvent;
}

async function runProcessChild(phase: "probe" | "replay", root: string, sessionId: string): Promise<ProcessEvent> {
  const processHandle = Bun.spawn([process.execPath, processChild, phase, root, sessionId], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const [stdout, stderr, code] = await within(Promise.all([
    new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text(), processHandle.exited,
  ]), `ordinary admission ${phase} child`);
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith("@@ordinary-action-admission@@"));
  if (code !== 0 || !line) throw new Error(`ordinary admission ${phase} child failed (${code}): ${stdout}\n${stderr}`);
  return JSON.parse(line.slice("@@ordinary-action-admission@@".length)) as ProcessEvent;
}

function admissionConnectionFactory(hooks: {
  throwAfterCommit?: () => boolean;
  throwBeforeCommit?: () => Error | undefined;
  throwAfterClose?: () => boolean;
  throwDuringBootstrap?: (sql: string) => Error | undefined;
  runs?: string[];
}) {
  return (file: string, flags: number) => {
    const database = new Database(file, flags);
    return {
      run(sql: string, bindings: readonly (string | number)[] = []) {
        hooks.runs?.push(sql);
        const injected = hooks.throwDuringBootstrap?.(sql);
        if (injected) throw injected;
        if (sql === "COMMIT") {
          const commitFailure = hooks.throwBeforeCommit?.();
          if (commitFailure) throw commitFailure;
        }
        if (bindings.length) database.run(sql, [...bindings]); else database.run(sql);
        if (sql === "COMMIT" && hooks.throwAfterCommit?.()) throw new Error("injected admission commit acknowledgement failure");
      },
      get<T>(sql: string, bindings: readonly (string | number)[] = []): T | undefined {
        return bindings.length ? database.query(sql).get(...bindings) as T | undefined : database.query(sql).get() as T | undefined;
      },
      pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
        const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
        return row ? Object.values(row)[0] : undefined;
      },
      close(throwOnError: true) {
        database.close(throwOnError);
        if (hooks.throwAfterClose?.()) throw new Error("injected admission close failure");
      },
    };
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** No subprocess is launched: exit and pipe delivery are separately controlled. */
function controlledProcessHandle() {
  const exit = deferred<number>();
  let stdoutController!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  let outputClosed = false; let exitResolved = false; let kills = 0;
  let signalCode: NodeJS.Signals | null = null;
  const closeOutput = () => {
    if (outputClosed) return; outputClosed = true;
    stdoutController.close(); stderrController.close();
  };
  const settleExit = (code: number, signal: NodeJS.Signals | null = null) => {
    if (exitResolved) return; exitResolved = true;
    signalCode = signal; exit.resolve(code);
  };
  const handle: ProcessHandle = {
    stdout: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { stdoutController = controller; } }),
    stderr: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { stderrController = controller; } }),
    stdin: { write: () => 0, end: () => 0, flush: () => 0, start: () => {}, ref: () => {}, unref: () => {} },
    exited: exit.promise,
    get signalCode() { return signalCode; },
    kill() { kills++; settleExit(137, "SIGKILL"); closeOutput(); },
  };
  return {
    handle,
    emit(event: ProcessEvent) {
      stdoutController.enqueue(new TextEncoder().encode(`@@ordinary-action-admission@@${JSON.stringify(event)}\n`));
    },
    settleExit, closeOutput,
    kills: () => kills,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("ordinary action did not reach the deterministic barrier");
}

function completion(action: "help" | "status"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action }) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function keeper(): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role: "keeper", id: OWNER } });
}

function operator(id = "operator:ordinary-action-recovery"): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role: "operator", id } });
}

function unauthenticated(): CompilerRequestAuthenticator {
  return () => ({ status: "unauthenticated" });
}

function jsonRequest(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function runtime(root: string, admission?: OrdinaryActionAdmissionCoordinator): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  const create: NonNullable<SessionRuntimeDependencies["createOrdinarySession"]> = ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
    const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
    session.getOpeningScene = async () => "offline opening";
    return session;
  };
  return {
    registry,
    dependencies: {
      registry,
      ordinaryIntentPolicy: "required",
      ordinarySnapshots: new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") }),
      sessionNamespace: new SessionNamespaceCoordinator(join(root, "sessions")),
      ...(admission ? { ordinaryActionAdmission: admission } : {}),
      createOrdinarySession: create,
      createOrdinaryRecoverySession: ({ id, storage, access, intentPolicy, runtimeDependencies }) => create({ id, ruleset: "cosmic-horror", persona: undefined, storage, access, intentPolicy, runtimeDependencies }),
    },
  };
}

async function request(root: string, current: ReturnType<typeof runtime>, path: string, init: RequestInit = {}, authenticator: CompilerRequestAuthenticator = keeper()): Promise<Response> {
  return handleRequest(
    new Request(`http://test${path}`, init),
    undefined, undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {}, {}, authenticator, undefined, undefined, undefined, { mode: "required" }, current.dependencies,
  );
}

async function createAndHydrate(root: string, first: ReturnType<typeof runtime>, second: ReturnType<typeof runtime>, authenticator: CompilerRequestAuthenticator = keeper()): Promise<string> {
  const created = await request(root, first, "/api/sessions", jsonRequest({
    ruleset: "cosmic-horror", archetype: "investigator", characterName: "Ada",
  }), authenticator);
  expect(created.status).toBe(201);
  const id = (await created.json() as { sessionId: string }).sessionId;
  const hydrated = await request(root, second, `/api/sessions/${id}`, {}, authenticator);
  expect(hydrated.status).toBe(200);
  expect(second.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
  return id;
}

function fakeSocket() {
  const sent: unknown[] = [];
  const ws = { send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as ServerWebSocket<WsConnectionData>;
  return { ws, sent };
}

beforeEach(() => {
  savedFetch = globalThis.fetch;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  LLMClient.resetDefeat();
  while (liveSockets.length) removeWsClient(liveSockets.pop()!);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("ordinary admission process event harness", () => {
  test("hold accepts the final event drained after exit has already won the wait", async () => {
    const fixture = controlledProcessHandle();
    const holder = spawnHoldingProcess("unused", "unused", fixture.handle);
    try {
      fixture.emit({ event: "model-entered", calls: 1 });
      expect(await holder.next()).toEqual({ event: "model-entered", calls: 1 });
      holder.release();
      const finished = holder.finish();
      fixture.settleExit(0);
      // A macrotask barrier lets the resolved exit win while both pipes remain
      // blocked. No elapsed-time sleep or process scheduling luck is needed.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const final = { event: "hold-result", status: 200, calls: 1 };
      fixture.emit(final); fixture.closeOutput();
      expect(await finished).toEqual(final);
    } finally {
      fixture.settleExit(0); fixture.closeOutput(); await holder.dispose();
    }
  });

  test("race accepts the final event drained after exit has already won the wait", async () => {
    const fixture = controlledProcessHandle();
    const child = spawnRaceProcess("unused", "unused", "alpha", fixture.handle);
    try {
      fixture.emit({ event: "race-ready", label: "alpha" });
      expect(await child.next()).toEqual({ event: "race-ready", label: "alpha" });
      const waiting = child.next(); fixture.settleExit(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const final = { event: "race-result", label: "alpha", status: 200 };
      fixture.emit(final); fixture.closeOutput();
      expect(await waiting).toEqual(final);
      await child.finish();
    } finally {
      fixture.settleExit(0); fixture.closeOutput(); await child.dispose();
    }
  });

  test("crash accepts the final event drained after exit has already won the wait", async () => {
    const fixture = controlledProcessHandle();
    const child = spawnCrashLeaseProcess("unused", "unused", fixture.handle);
    try {
      const waiting = child.next(); fixture.settleExit(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const final = { event: "crash-lease-acquired", expiresAt: 100 };
      fixture.emit(final); fixture.closeOutput();
      expect(await waiting).toEqual(final);
    } finally {
      fixture.settleExit(0); fixture.closeOutput(); await child.dispose();
    }
  });

  for (const kind of ["hold", "race", "crash"] as const) {
    test(`${kind} rejects zero exit without a protocol event and reports code and signal`, async () => {
      const fixture = controlledProcessHandle();
      const child = kind === "hold" ? spawnHoldingProcess("unused", "unused", fixture.handle)
        : kind === "race" ? spawnRaceProcess("unused", "unused", "alpha", fixture.handle)
          : spawnCrashLeaseProcess("unused", "unused", fixture.handle);
      try {
        const waiting = child.next(); fixture.settleExit(0);
        await new Promise<void>((resolve) => setImmediate(resolve));
        fixture.closeOutput();
        await expect(waiting).rejects.toThrow(/exited before event \(code=0, signal=null\)/);
      } finally {
        fixture.settleExit(0); fixture.closeOutput(); await child.dispose();
      }
    });
  }

  test("hold rejects nonzero completion even with a valid final protocol event", async () => {
    const fixture = controlledProcessHandle();
    const holder = spawnHoldingProcess("unused", "unused", fixture.handle);
    try {
      fixture.emit({ event: "hold-result", status: 200, calls: 1 });
      fixture.settleExit(23, "SIGTERM"); fixture.closeOutput();
      await expect(holder.finish()).rejects.toThrow(/failed \(code=23, signal=SIGTERM\)/);
    } finally { await holder.dispose(); }
  });

  test("race rejects nonzero completion even with a valid final protocol event", async () => {
    const fixture = controlledProcessHandle();
    const child = spawnRaceProcess("unused", "unused", "alpha", fixture.handle);
    try {
      const final = { event: "race-result", label: "alpha", status: 200 };
      fixture.emit(final); fixture.settleExit(23, "SIGTERM"); fixture.closeOutput();
      expect(await child.next()).toEqual(final);
      await expect(child.finish()).rejects.toThrow(/failed \(code=23, signal=SIGTERM\)/);
    } finally { await child.dispose(); }
  });

  test("crash killAndDrain retains its expected process-death semantics", async () => {
    const fixture = controlledProcessHandle();
    const child = spawnCrashLeaseProcess("unused", "unused", fixture.handle);
    fixture.emit({ event: "crash-lease-acquired", expiresAt: 100 });
    expect(await child.next()).toEqual({ event: "crash-lease-acquired", expiresAt: 100 });
    await child.killAndDrain();
    expect(fixture.kills()).toBe(1);
    expect(await fixture.handle.exited).toBe(137);
    expect(fixture.handle.signalCode).toBe("SIGKILL");
    await child.dispose();
    expect(fixture.kills()).toBe(1);
  });
});

describe("ordinary durable action pre-execution admission", () => {
  test("uses a short bounded SQLite wait by default and preserves explicit zero", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-busy-timeout-"));
    const runs: string[] = [];
    try {
      const coordinator = new OrdinaryActionAdmissionCoordinator(root, {}, {
        connectionFactory: admissionConnectionFactory({ runs }),
      });
      const acquired = coordinator.acquire({
        sessionId: "ordinary-busy-timeout-session", expectedGeneration: 0,
        actionId: "ordinary-busy-timeout-action", requestHash: "a".repeat(64),
      });
      expect(runs).toContain("PRAGMA busy_timeout = 25");
      expect(acquired.status).toBe("acquired");
      if (acquired.status === "acquired") acquired.release();
      const immediateRuns: string[] = [];
      const immediate = new OrdinaryActionAdmissionCoordinator(root, {}, {
        busyTimeoutMs: 0,
        connectionFactory: admissionConnectionFactory({ runs: immediateRuns }),
      }).acquire({
        sessionId: "ordinary-busy-timeout-immediate-session", expectedGeneration: 0,
        actionId: "ordinary-busy-timeout-immediate-action", requestHash: "b".repeat(64),
      });
      expect(immediateRuns).toContain("PRAGMA busy_timeout = 0");
      expect(immediate.status).toBe("acquired");
      if (immediate.status === "acquired") immediate.release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("maps SQLite extended busy and locked bootstrap codes to ordinary busy without masking I/O failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-extended-contention-"));
    const unavailableRoot = mkdtempSync(join(tmpdir(), "ordinary-action-bootstrap-ioerr-"));
    const binding = (sessionId: string) => ({ sessionId, expectedGeneration: 0, actionId: "ordinary-extended-contention-action", requestHash: "a".repeat(64) });
    const bootstrapError = (code: string) => Object.assign(new Error("SQLite bootstrap failed"), { code });
    try {
      for (const code of ["SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED_SHAREDCACHE"]) {
        const coordinator = new OrdinaryActionAdmissionCoordinator(root, {}, {
          connectionFactory: admissionConnectionFactory({
            throwDuringBootstrap: (sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS ordinary_action_admission_policy") ? bootstrapError(code) : undefined,
          }),
        });
        expect(coordinator.acquire(binding(`ordinary-${code.toLowerCase()}`))).toMatchObject({
          status: "refused", code: "ORDINARY_ACTION_BUSY",
        });
      }

      const unavailable = new OrdinaryActionAdmissionCoordinator(unavailableRoot, {}, {
        connectionFactory: admissionConnectionFactory({
          throwDuringBootstrap: (sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS ordinary_action_admission_policy") ? bootstrapError("SQLITE_IOERR") : undefined,
        }),
      });
      expect(unavailable.acquire(binding("ordinary-sqlite-ioerr"))).toMatchObject({
        status: "refused", code: "ORDINARY_ACTION_STORAGE_UNAVAILABLE",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(unavailableRoot, { recursive: true, force: true });
    }
  });

  test("retries one pre-outcome SQLite BUSY COMMIT on the same active transaction", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-commit-contention-"));
    const binding = (actionId: string, requestHash: string) => ({
      sessionId: "ordinary-commit-contention-session", expectedGeneration: 0, actionId, requestHash,
    });
    try {
      let inject = true;
      let commits = 0;
      const coordinator = new OrdinaryActionAdmissionCoordinator(root, {}, {
        connectionFactory: admissionConnectionFactory({
          throwBeforeCommit: () => {
            commits++;
            if (!inject) return undefined;
            inject = false;
            return Object.assign(new Error("SQLite commit contention"), { code: "SQLITE_BUSY_SNAPSHOT" });
          },
        }),
      });
      const acquired = coordinator.acquire(binding("ordinary-commit-contender", "b".repeat(64)));
      expect(acquired.status).toBe("acquired");
      expect(commits).toBe(2);
      if (acquired.status === "acquired") acquired.release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("rolls back a persistently busy pre-outcome COMMIT and returns ordinary busy", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-persistent-commit-contention-"));
    const binding = (actionId: string, requestHash: string) => ({
      sessionId: "ordinary-persistent-commit-contention-session", expectedGeneration: 0, actionId, requestHash,
    });
    try {
      let commits = 0;
      const coordinator = new OrdinaryActionAdmissionCoordinator(root, {}, {
        connectionFactory: admissionConnectionFactory({
          throwBeforeCommit: () => {
            commits++;
            return Object.assign(new Error("SQLite commit contention"), { code: "SQLITE_BUSY_SNAPSHOT" });
          },
        }),
      });
      expect(coordinator.acquire(binding("ordinary-persistent-commit", "a".repeat(64)))).toMatchObject({
        status: "refused", code: "ORDINARY_ACTION_BUSY",
      });
      expect(commits).toBe(2);
      const afterRollback = new OrdinaryActionAdmissionCoordinator(root).acquire(binding("ordinary-persistent-after-rollback", "b".repeat(64)));
      expect(afterRollback.status).toBe("acquired");
      if (afterRollback.status === "acquired") afterRollback.release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("fails closed across acquire/publish COMMIT uncertainty and preserves acknowledged commits across close faults", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-admission-faults-"));
    const closeRoot = mkdtempSync(join(tmpdir(), "ordinary-action-admission-close-fault-"));
    const publishRoot = mkdtempSync(join(tmpdir(), "ordinary-action-admission-publish-fault-"));
    const binding = (sessionId: string, actionId: string, hash: string) => ({ sessionId, expectedGeneration: 0, actionId, requestHash: hash.repeat(64) });
    try {
      let now = 0; let acquireCommits = 0;
      const uncertain = new OrdinaryActionAdmissionCoordinator(root, { leaseTtlMs: 100, now: () => now }, {
        connectionFactory: admissionConnectionFactory({ throwAfterCommit: () => ++acquireCommits === 1 }),
      });
      expect(uncertain.acquire(binding("session-commit-uncertain", "action-commit-uncertain", "a"))).toEqual({
        status: "indeterminate", code: "ORDINARY_ACTION_INDETERMINATE", retryAfterSeconds: 60,
      });
      expect(acquireCommits).toBe(1);
      const observer = new OrdinaryActionAdmissionCoordinator(root, { leaseTtlMs: 100, now: () => now });
      expect(observer.acquire(binding("session-commit-uncertain", "action-contender-active", "b"))).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_BUSY" });
      now = 101;
      expect(observer.acquire(binding("session-commit-uncertain", "action-contender-expired", "c"))).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_QUARANTINED" });
      expect(observer.recoverQuarantinedForOperator({ sessionId: "session-commit-uncertain", currentGeneration: 0 })).toEqual({ status: "recovered", sessionId: "session-commit-uncertain" });

      let closeFaults = 0;
      const closeFault = new OrdinaryActionAdmissionCoordinator(closeRoot, { leaseTtlMs: 100, now: () => now }, {
        connectionFactory: admissionConnectionFactory({ throwAfterClose: () => ++closeFaults <= 2 }),
      });
      const closeHolder = closeFault.acquire(binding("session-close-fault", "action-close-holder", "d"));
      expect(closeHolder.status).toBe("acquired");
      const closeObserver = new OrdinaryActionAdmissionCoordinator(closeRoot, { leaseTtlMs: 100, now: () => now });
      expect(closeObserver.acquire(binding("session-close-fault", "action-close-contender", "e"))).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_BUSY" });
      if (closeHolder.status !== "acquired") throw new Error("close-fault holder was not acquired");
      closeHolder.release();
      const afterClose = closeObserver.acquire(binding("session-close-fault", "action-after-close", "f"));
      expect(afterClose.status).toBe("acquired");
      if (afterClose.status === "acquired") afterClose.release();

      let publishCommits = 0;
      const publishFault = new OrdinaryActionAdmissionCoordinator(publishRoot, { leaseTtlMs: 100, now: () => now }, {
        connectionFactory: admissionConnectionFactory({ throwAfterCommit: () => ++publishCommits === 2 }),
      });
      const publishHolder = publishFault.acquire(binding("session-publish-uncertain", "action-publish-holder", "1"));
      expect(publishHolder.status).toBe("acquired");
      if (publishHolder.status !== "acquired") throw new Error("publish-fault holder was not acquired");
      let publications = 0;
      expect(publishHolder.withActiveFence(() => { publications++; return "published"; })).toEqual({
        status: "indeterminate", code: "ORDINARY_ACTION_INDETERMINATE", retryAfterSeconds: 60, value: "published",
      });
      expect(publications).toBe(1);
      const publishObserver = new OrdinaryActionAdmissionCoordinator(publishRoot, { leaseTtlMs: 100, now: () => now });
      expect(publishObserver.acquire(binding("session-publish-uncertain", "action-publish-contender", "2"))).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_BUSY" });
      publishHolder.release();
      const afterPublishSettle = publishObserver.acquire(binding("session-publish-uncertain", "action-publish-after-settle", "3"));
      expect(afterPublishSettle.status).toBe("acquired");
      if (afterPublishSettle.status === "acquired") afterPublishSettle.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(closeRoot, { recursive: true, force: true });
      rmSync(publishRoot, { recursive: true, force: true });
    }
  });

  test("admits exactly one provider execution when two fresh Bun processes race their first coordinator acquire", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-first-acquire-race-"));
    let first: ReturnType<typeof spawnRaceProcess> | undefined; let second: ReturnType<typeof spawnRaceProcess> | undefined;
    try {
      const id = "ordinary-action-first-acquire-race-session";
      first = spawnRaceProcess(root, id, "alpha"); second = spawnRaceProcess(root, id, "bravo");
      expect(await Promise.all([first.next(), second.next()])).toEqual([
        { event: "race-ready", label: "alpha" }, { event: "race-ready", label: "bravo" },
      ]);
      await Promise.all([first.start(), second.start()]);
      const raced = await Promise.all([first.next(), second.next()]);
      const modelEntries = raced.filter((event) => event.event === "model-entered");
      const refusals = raced.filter((event) => event.event === "race-result");
      expect(modelEntries).toHaveLength(1);
      expect(refusals).toHaveLength(1);
      expect(modelEntries[0]).toMatchObject({ calls: 1 });
      expect(refusals[0]).toMatchObject({ status: 503, calls: 0, body: { code: "ordinary_action_busy" } });

      await Promise.all([first.release(), second.release()]);
      const winner = raced[0]!.event === "model-entered" ? first : second;
      expect(await winner.next()).toMatchObject({ event: "race-result", status: 200, calls: 1, body: { code: "provider_completed" } });
      await Promise.all([first.finish(), second.finish()]);
    } finally {
      await Promise.all([first?.dispose(), second?.dispose()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("authenticates admission recovery before namespace reconciliation, locator lookup, snapshot access, or body consumption", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-recovery-auth-order-"));
    const current = runtime(root); const hydration = runtime(root);
    try {
      const id = await createAndHydrate(root, current, hydration);
      const touches = { namespace: 0, locator: 0, snapshot: 0 };
      const namespace = current.dependencies.sessionNamespace!;
      current.dependencies.sessionNamespace = new Proxy(namespace, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            touches.namespace++;
            if (property === "read") touches.locator++;
            return Reflect.apply(value, target, args);
          };
        },
      });
      const snapshots = current.dependencies.ordinarySnapshots!;
      current.dependencies.ordinarySnapshots = new Proxy(snapshots, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { touches.snapshot++; return Reflect.apply(value, target, args); };
        },
      });
      const unreadBody = () => {
        let pulls = 0;
        return {
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++;
              controller.enqueue(new TextEncoder().encode('{"fence":"caller-controlled"}'));
              controller.close();
            },
          }, { highWaterMark: 0 }),
          pulls: () => pulls,
        };
      };

      const anonymousBody = unreadBody();
      const anonymous = await request(root, current, `/api/sessions/${id}/action-admission/recover`, {
        method: "POST", body: anonymousBody.body,
      }, unauthenticated());
      expect(anonymous.status).toBe(401);
      expect(anonymousBody.pulls()).toBe(0);
      expect(touches).toEqual({ namespace: 0, locator: 0, snapshot: 0 });

      const keeperBody = unreadBody();
      const deniedKeeper = await request(root, current, `/api/sessions/${id}/action-admission/recover`, {
        method: "POST", body: keeperBody.body,
      });
      expect(deniedKeeper.status).toBe(403);
      expect(keeperBody.pulls()).toBe(0);
      expect(touches).toEqual({ namespace: 0, locator: 0, snapshot: 0 });

      const allowedOperator = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" }, operator());
      expect(allowedOperator.status).toBe(200);
      expect(touches.namespace).toBeGreaterThan(0);
      expect(touches.locator).toBeGreaterThan(0);
      expect(touches.snapshot).toBeGreaterThan(0);
    } finally {
      for (const session of [...current.registry.values(), ...hydration.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("rejects an injected ordinary admission coordinator outside the exact runtime SQLite domain before route work", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-admission-domain-root-"));
    const runtimeRoot = join(root, "sessions");
    const foreignRoot = join(root, "foreign-lock-domain");
    mkdirSync(runtimeRoot);
    mkdirSync(foreignRoot);
    const foreign = new OrdinaryActionAdmissionCoordinator(foreignRoot);
    const current = runtime(root, foreign);
    const canonical = new OrdinaryActionAdmissionCoordinator(runtimeRoot);
    const binding = {
      sessionId: "ordinary-action-admission-domain-session",
      expectedGeneration: 0,
      actionId: "ordinary-action-admission-domain-action",
      requestHash: "a".repeat(64),
    };
    let foreignLease: ReturnType<OrdinaryActionAdmissionCoordinator["acquire"]> | undefined;
    let canonicalLease: ReturnType<OrdinaryActionAdmissionCoordinator["acquire"]> | undefined;
    try {
      // This is the concrete split-domain hazard: both physical databases can
      // grant the same operation. The server must reject the injected foreign
      // coordinator before it observes any ordinary runtime authority.
      foreignLease = foreign.acquire(binding);
      canonicalLease = canonical.acquire(binding);
      expect(foreignLease.status).toBe("acquired");
      expect(canonicalLease.status).toBe("acquired");

      const touches = { namespace: 0, locator: 0, snapshot: 0 };
      const namespace = current.dependencies.sessionNamespace!;
      current.dependencies.sessionNamespace = new Proxy(namespace, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            touches.namespace++;
            if (property === "read") touches.locator++;
            return Reflect.apply(value, target, args);
          };
        },
      });
      const snapshots = current.dependencies.ordinarySnapshots!;
      current.dependencies.ordinarySnapshots = new Proxy(snapshots, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { touches.snapshot++; return Reflect.apply(value, target, args); };
        },
      });
      let bodyPulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          bodyPulls++;
          controller.enqueue(new TextEncoder().encode('{"input":"must remain unread","actionId":"ordinary-domain-body-0001","expectedGeneration":0}'));
          controller.close();
        },
      }, { highWaterMark: 0 });
      const response = await request(root, current, "/api/sessions/018f14a2-c2be-7b73-b291-6e64eaf7869a/action", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(await response.json()).toEqual({
        error: {
          stage: "persistence",
          code: "ORDINARY_ACTION_ADMISSION_DOMAIN_MISMATCH",
          message: "ordinary action admission is unavailable",
        },
      });
      expect(bodyPulls).toBe(0);
      expect(touches).toEqual({ namespace: 0, locator: 0, snapshot: 0 });
      expect(existsSync(join(root, "careers"))).toBe(false);
      expect(existsSync(join(runtimeRoot, "ordinary-snapshots"))).toBe(false);
    } finally {
      if (foreignLease?.status === "acquired") foreignLease.release();
      if (canonicalLease?.status === "acquired") canonicalLease.release();
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("rejects a same-root alternate admission filename but permits the exact canonical file", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-admission-domain-file-"));
    const runtimeRoot = join(root, "sessions");
    const alternate = new OrdinaryActionAdmissionCoordinator(runtimeRoot, {}, { fileName: ".alternate-ordinary-action-admission.sqlite" });
    const canonical = new OrdinaryActionAdmissionCoordinator(runtimeRoot);
    try {
      const mismatch = await request(root, runtime(root, alternate), "/api/sessions/018f14a2-c2be-7b73-b291-6e64eaf7869a/action", {
        method: "POST",
      });
      expect(mismatch.status).toBe(503);
      expect(mismatch.headers.get("Retry-After")).toBe("1");
      expect(await mismatch.json()).toMatchObject({ error: { stage: "persistence", code: "ORDINARY_ACTION_ADMISSION_DOMAIN_MISMATCH" } });

      const exact = await request(root, runtime(root, canonical), "/api/sessions/018f14a2-c2be-7b73-b291-6e64eaf7869a/action", {
        method: "POST",
      });
      expect(canonical.file).toBe(join(runtimeRoot, ".ordinary-action-admission.sqlite"));
      expect(exact.status).toBe(404);
      expect(JSON.stringify(await exact.json())).not.toContain("ORDINARY_ACTION_ADMISSION_DOMAIN_MISMATCH");

      if (process.platform === "win32") {
        const caseVariant = new OrdinaryActionAdmissionCoordinator(runtimeRoot.toUpperCase());
        const caseEquivalent = await request(root, runtime(root, caseVariant), "/api/sessions/018f14a2-c2be-7b73-b291-6e64eaf7869a/action", {
          method: "POST",
        });
        expect(caseEquivalent.status).toBe(404);
        expect(JSON.stringify(await caseEquivalent.json())).not.toContain("ORDINARY_ACTION_ADMISSION_DOMAIN_MISMATCH");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  test("keeps ordinary admission domain mismatch behind recovery authentication and bodyless operator ordering", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-admission-domain-recovery-auth-"));
    const current = runtime(root, new OrdinaryActionAdmissionCoordinator(join(root, "foreign-lock-domain")));
    const id = "018f14a2-c2be-7b73-b291-6e64eaf7869a";
    const touches = { namespace: 0, locator: 0, snapshot: 0 };
    const namespace = current.dependencies.sessionNamespace!;
    current.dependencies.sessionNamespace = new Proxy(namespace, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          touches.namespace++;
          if (property === "read") touches.locator++;
          return Reflect.apply(value, target, args);
        };
      },
    });
    const snapshots = current.dependencies.ordinarySnapshots!;
    current.dependencies.ordinarySnapshots = new Proxy(snapshots, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => { touches.snapshot++; return Reflect.apply(value, target, args); };
      },
    });
    const unreadBody = () => {
      let pulls = 0;
      return {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode('{"fence":"caller-controlled"}'));
            controller.close();
          },
        }, { highWaterMark: 0 }),
        pulls: () => pulls,
      };
    };
    try {
      const anonymousBody = unreadBody();
      const anonymous = await request(root, current, `/api/sessions/${id}/action-admission/recover`, {
        method: "POST", body: anonymousBody.body,
      }, unauthenticated());
      expect(anonymous.status).toBe(401);
      expect(anonymousBody.pulls()).toBe(0);

      const keeperBody = unreadBody();
      const deniedKeeper = await request(root, current, `/api/sessions/${id}/action-admission/recover`, {
        method: "POST", body: keeperBody.body,
      });
      expect(deniedKeeper.status).toBe(403);
      expect(keeperBody.pulls()).toBe(0);

      const operatorBody = unreadBody();
      const bodyfulOperator = await request(root, current, `/api/sessions/${id}/action-admission/recover`, {
        method: "POST", body: operatorBody.body,
      }, operator());
      expect(bodyfulOperator.status).toBe(400);
      expect(operatorBody.pulls()).toBe(0);

      const operatorMismatch = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" }, operator());
      expect(operatorMismatch.status).toBe(503);
      expect(operatorMismatch.headers.get("Retry-After")).toBe("1");
      expect(await operatorMismatch.json()).toMatchObject({ error: { stage: "persistence", code: "ORDINARY_ACTION_ADMISSION_DOMAIN_MISMATCH" } });
      expect(touches).toEqual({ namespace: 0, locator: 0, snapshot: 0 });
    } finally {
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("fails every ordinary durable write route closed after host auth without consuming its body or observing durable authority", async () => {
    const routes = [
      // `/action` is also the legacy compiled write route. Until the durable
      // namespace is read it is intentionally ambiguous, so an ordinary lock
      // domain mismatch fail-closes it rather than guessing the session kind.
      { label: "legacy action (ordinary-or-compiled ambiguity)", suffix: "action" },
      { label: "character patch", suffix: "character" },
      { label: "party create", suffix: "party" },
      { label: "luck spend", suffix: "luck-spend" },
      { label: "KP message", suffix: "kp/send-message" },
    ] as const;
    for (const route of routes) {
      const root = mkdtempSync(join(tmpdir(), `ordinary-action-admission-domain-${route.suffix.replace("/", "-")}-`));
      const current = runtime(root, new OrdinaryActionAdmissionCoordinator(join(root, "foreign-lock-domain")));
      const touches = { namespace: 0, locator: 0, snapshot: 0 };
      const namespace = current.dependencies.sessionNamespace!;
      current.dependencies.sessionNamespace = new Proxy(namespace, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            touches.namespace++;
            if (property === "read") touches.locator++;
            return Reflect.apply(value, target, args);
          };
        },
      });
      const snapshots = current.dependencies.ordinarySnapshots!;
      current.dependencies.ordinarySnapshots = new Proxy(snapshots, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { touches.snapshot++; return Reflect.apply(value, target, args); };
        },
      });
      const unreadBody = () => {
        let pulls = 0;
        return {
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++;
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
            },
          }, { highWaterMark: 0 }),
          pulls: () => pulls,
        };
      };
      try {
        const anonymousBody = unreadBody();
        const anonymous = await request(root, current, `/api/sessions/018f14a2-c2be-7b73-b291-6e64eaf7869a/${route.suffix}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: anonymousBody.body,
        }, unauthenticated());
        expect(anonymous.status, route.label).toBe(401);
        expect(anonymousBody.pulls(), route.label).toBe(0);
        expect(touches, route.label).toEqual({ namespace: 0, locator: 0, snapshot: 0 });

        const authenticatedBody = unreadBody();
        const mismatch = await request(root, current, `/api/sessions/018f14a2-c2be-7b73-b291-6e64eaf7869a/${route.suffix}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: authenticatedBody.body,
        });
        expect(mismatch.status, route.label).toBe(503);
        expect(mismatch.headers.get("Retry-After"), route.label).toBe("1");
        expect(await mismatch.json(), route.label).toMatchObject({
          error: { stage: "persistence", code: "ORDINARY_ACTION_ADMISSION_DOMAIN_MISMATCH" },
        });
        expect(authenticatedBody.pulls(), route.label).toBe(0);
        expect(touches, route.label).toEqual({ namespace: 0, locator: 0, snapshot: 0 });
        // Snapshot calls include all receipt access; a mismatch must not
        // create a Career root or an ordinary snapshot/receipt directory.
        expect(existsSync(join(root, "careers")), route.label).toBe(false);
        expect(existsSync(join(root, "sessions", "ordinary-snapshots")), route.label).toBe(false);
      } finally {
        for (const session of current.registry.values()) session.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 15_000);

  test("coordinates two fresh Bun runtimes before model entry and replays the committed receipt in a third process", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-process-admission-"));
    const seed = runtime(root); const hydrated = runtime(root); let holder: ReturnType<typeof spawnHoldingProcess> | undefined;
    try {
      const id = await createAndHydrate(root, seed, hydrated);
      for (const session of [...seed.registry.values(), ...hydrated.registry.values()]) session.close();
      seed.registry.clear(); hydrated.registry.clear();
      holder = spawnHoldingProcess(root, id);
      expect(await holder.next()).toEqual({ event: "model-entered", calls: 1 });

      const probe = await runProcessChild("probe", root, id);
      expect(probe).toEqual({
        event: "probe-result", calls: 0, broadcasts: 0, round: 0, actionMessages: 0,
        different: { status: 503, body: { code: "ordinary_action_busy", ordinaryGeneration: 0 }, retryAfter: "1" },
        same: { status: 503, body: { code: "ordinary_action_busy", ordinaryGeneration: 0 }, retryAfter: "1" },
      });

      holder.release();
      const committed = await holder.finish();
      expect(committed).toMatchObject({ event: "hold-result", status: 200, calls: 1, disposition: "committed", body: { ordinaryGeneration: 1 } });

      const replay = await runProcessChild("replay", root, id);
      expect(replay).toMatchObject({ event: "replay-result", status: 200, calls: 0, broadcasts: 0, disposition: "duplicate", body: { ordinaryGeneration: 1 } });
      const durable = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(durable.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(durable.findActionReceipt(id, "ordinary-process-admission-action-0001")).toMatchObject({ status: "ok", value: { generation: 1 } });
    } finally {
      await holder?.dispose();
      for (const session of [...seed.registry.values(), ...hydrated.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rechecks durable authority after a released cross-process lease handoff before deriving", async () => {
    const first = { input: "fresh process held action", actionId: "ordinary-process-admission-action-0001", expectedGeneration: 0 };
    const scenarios = [
      {
        label: "different action",
        request: { input: "stale predecessor must not reach provider", actionId: "ordinary-process-handoff-loser-0002", expectedGeneration: 0 },
        status: 409,
        disposition: null,
        body: { code: "ordinary_generation_conflict", ordinaryGeneration: 1 },
      },
      {
        label: "same action and request hash",
        request: first,
        status: 200,
        disposition: "duplicate",
        body: undefined,
      },
    ] as const;
    for (const scenario of scenarios) {
      const root = mkdtempSync(join(tmpdir(), "ordinary-action-post-acquire-authority-"));
      const staleAdmission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"));
      const seed = runtime(root); const staleRuntime = runtime(root, staleAdmission);
      let providerCalls = 0;
      globalThis.fetch = (async () => { providerCalls++; return completion("help"); }) as unknown as typeof fetch;
      const originalRestore = GameSession.prototype.restoreOrdinarySessionSnapshot;
      let restores = 0;
      try {
        const id = await createAndHydrate(root, seed, staleRuntime);
        GameSession.prototype.restoreOrdinarySessionSnapshot = function (...args: Parameters<GameSession["restoreOrdinarySessionSnapshot"]>) {
          restores++;
          return originalRestore.apply(this, args);
        };
        let intercepted = false;
        let winner: ProcessEvent | undefined;
        staleRuntime.dependencies.ordinaryActionAdmission = new Proxy(staleAdmission, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== "acquire" || typeof value !== "function") return value;
            return (...args: unknown[]) => {
              // `runOrdinaryOperationTransaction` has already read its g0
              // predecessor and captured the matching Career/source snapshot
              // when it reaches acquire(). Pause at that exact handoff, let a
              // fresh process commit g1 and release its SQLite lease, then
              // let this old request acquire the now-free lease.
              if (!intercepted) {
                intercepted = true;
                winner = runAdvancingProcessSynchronously(root, id);
              }
              return Reflect.apply(value, target, args);
            };
          },
        });

        const response = await request(root, staleRuntime, `/api/sessions/${id}/action`, jsonRequest(scenario.request));
        const body = await response.json();
        expect(intercepted, scenario.label).toBe(true);
        expect(winner, scenario.label).toMatchObject({
          event: "advance-result", status: 200, calls: 1, disposition: "committed", body: { ordinaryGeneration: 1 },
        });
        expect(response.status, scenario.label).toBe(scenario.status);
        expect(response.headers.get("X-Ordinary-Action-Disposition"), scenario.label).toBe(scenario.disposition);
        if (scenario.disposition === "duplicate") {
          expect(response.headers.get("X-Ordinary-Current-Generation"), scenario.label).toBe("1");
        }
        // This is the regression assertion: g0 was observed before the other
        // process published g1, yet the stale request must never enter its
        // local provider after it wins the now-free admission lease.
        expect(providerCalls, scenario.label).toBe(0);
        if (scenario.body === undefined) expect(body, scenario.label).toEqual(winner?.body);
        else expect(body, scenario.label).toEqual(scenario.body);
        // Exactly one restore is allowed, the authoritative g1 rehydrate,
        // never a stale g0 candidate plus g1 recovery pair.
        expect(restores, scenario.label).toBe(1);
        expect(staleRuntime.registry.get(id)?.getOrdinaryDurableIdentity(), scenario.label).toMatchObject({ generation: 1 });
        const released = staleAdmission.acquire({
          sessionId: id,
          expectedGeneration: 1,
          actionId: "ordinary-process-handoff-release-0003",
          requestHash: "f".repeat(64),
        });
        expect(released, scenario.label).toMatchObject({ status: "acquired" });
        if (released.status === "acquired") released.release();
      } finally {
        GameSession.prototype.restoreOrdinarySessionSnapshot = originalRestore;
        for (const session of [...seed.registry.values(), ...staleRuntime.registry.values()]) session.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("admits at most one different action for a shared session generation before model execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-admission-"));
    const firstRuntime = runtime(root); const secondRuntime = runtime(root);
    const firstModel = deferred<Response>(); let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? firstModel.promise : completion("status"))) as unknown as typeof fetch;
    const originalRestore = GameSession.prototype.restoreOrdinarySessionSnapshot;
    let restoreCalls = 0;
    try {
      const id = await createAndHydrate(root, firstRuntime, secondRuntime);
      GameSession.prototype.restoreOrdinarySessionSnapshot = function (...args: Parameters<GameSession["restoreOrdinarySessionSnapshot"]>) {
        restoreCalls++;
        return originalRestore.apply(this, args);
      };
      const socket = fakeSocket(); createWsClient(socket.ws, id, "player", "p1"); liveSockets.push(socket.ws);
      const firstBody = { input: "first generation action", actionId: "ordinary-admission-action-0001", expectedGeneration: 0 };
      const secondBody = { input: "competing generation action", actionId: "ordinary-admission-action-0002", expectedGeneration: 0 };
      const firstPromise = request(root, firstRuntime, `/api/sessions/${id}/action`, jsonRequest(firstBody));
      await eventually(() => calls === 1);
      const stagingParent = join(root, "careers", ".ordinary-action-staging");
      const stagingBeforeBusy = existsSync(stagingParent) ? readdirSync(stagingParent).sort() : [];
      const restoresBeforeBusy = restoreCalls;
      const secondResponse = await request(root, secondRuntime, `/api/sessions/${id}/action`, jsonRequest(secondBody));
      const secondJson = await secondResponse.json() as { code?: string; ordinaryGeneration?: number };
      const stateBeforeRelease = [firstRuntime.registry.get(id), secondRuntime.registry.get(id)].map((session) => ({
        round: session?.round,
        actionMessages: session?.getPlayerHistory("p1").messages.filter((message) => message.type === "action").length,
      }));
      const broadcastsBeforeRelease = socket.sent.length;
      const callsBeforeRelease = calls;
      const stagingAfterBusy = existsSync(stagingParent) ? readdirSync(stagingParent).sort() : [];
      const restoresAfterBusy = restoreCalls;
      firstModel.resolve(completion("help"));
      const firstResponse = await firstPromise;

      expect(secondResponse.status).toBe(503);
      expect(secondJson).toEqual({ code: "ordinary_action_busy", ordinaryGeneration: 0 });
      expect(secondResponse.headers.get("Retry-After")).toBe("1");
      expect(callsBeforeRelease).toBe(1);
      expect(restoresBeforeBusy).toBe(1);
      expect(restoresAfterBusy).toBe(restoresBeforeBusy);
      expect(stagingBeforeBusy).toHaveLength(1);
      expect(stagingAfterBusy).toEqual(stagingBeforeBusy);
      expect(stateBeforeRelease).toEqual([{ round: 0, actionMessages: 0 }, { round: 0, actionMessages: 0 }]);
      expect(broadcastsBeforeRelease).toBe(0);
      expect(firstResponse.status).toBe(200);
      expect(calls).toBe(1);
    } finally {
      GameSession.prototype.restoreOrdinarySessionSnapshot = originalRestore;
      firstModel.resolve(completion("help"));
      for (const session of [...firstRuntime.registry.values(), ...secondRuntime.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("executes one concurrent identical action and replays its durable receipt after commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-idempotent-admission-"));
    const firstRuntime = runtime(root); const secondRuntime = runtime(root);
    const firstModel = deferred<Response>(); let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? firstModel.promise : completion("status"))) as unknown as typeof fetch;
    try {
      const id = await createAndHydrate(root, firstRuntime, secondRuntime);
      const action = { input: "idempotent generation action", actionId: "ordinary-admission-same-action-0001", expectedGeneration: 0 };
      const firstPromise = request(root, firstRuntime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);
      const concurrent = await request(root, secondRuntime, `/api/sessions/${id}/action`, jsonRequest(action));
      const concurrentBody = await concurrent.json();
      const callsWhileBlocked = calls;
      firstModel.resolve(completion("help"));
      const firstResponse = await firstPromise; const firstBody = await firstResponse.json();
      const replay = await request(root, secondRuntime, `/api/sessions/${id}/action`, jsonRequest(action));
      const replayBody = await replay.json();

      expect(concurrent.status).toBe(503);
      expect(concurrentBody).toEqual({ code: "ordinary_action_busy", ordinaryGeneration: 0 });
      expect(callsWhileBlocked).toBe(1);
      expect(firstResponse.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
      expect(replayBody).toEqual(firstBody);
      expect(calls).toBe(1);
    } finally {
      firstModel.resolve(completion("help"));
      for (const session of [...firstRuntime.registry.values(), ...secondRuntime.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("replays a durable receipt without another model call after snapshot commit but before HTTP rehydrate/response", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-post-commit-replay-"));
    const firstRuntime = runtime(root); const secondRuntime = runtime(root);
    let modelCalls = 0;
    globalThis.fetch = (async () => { modelCalls++; return completion("help"); }) as unknown as typeof fetch;
    const originalRestore = GameSession.prototype.restoreOrdinarySessionSnapshot;
    let restores = 0; let injected = false;
    try {
      const id = await createAndHydrate(root, firstRuntime, secondRuntime);
      const socket = fakeSocket(); createWsClient(socket.ws, id, "player", "p1"); liveSockets.push(socket.ws);
      GameSession.prototype.restoreOrdinarySessionSnapshot = function (...args: Parameters<GameSession["restoreOrdinarySessionSnapshot"]>) {
        restores++;
        if (restores === 2) { injected = true; throw new Error("injected post-commit rehydrate failure"); }
        return originalRestore.apply(this, args);
      };
      const action = { input: "commit before response fault", actionId: "ordinary-post-commit-replay-action-0001", expectedGeneration: 0 };
      const failedResponse = await request(root, firstRuntime, `/api/sessions/${id}/action`, jsonRequest(action));
      expect(failedResponse.status).toBe(503);
      expect(await failedResponse.json()).toEqual({ code: "ordinary_unavailable" });
      expect(injected).toBe(true);
      expect(modelCalls).toBe(1);
      expect(socket.sent).toHaveLength(0);

      const durable = firstRuntime.dependencies.ordinarySnapshots!.read(id);
      expect(durable.status).toBe("ok");
      if (durable.status !== "ok") throw new Error("post-commit receipt was not durable");
      expect(durable.value.generation).toBe(1);
      const receipt = firstRuntime.dependencies.ordinarySnapshots!.findActionReceipt(id, action.actionId);
      expect(receipt).toMatchObject({ status: "ok", value: { generation: 1 } });

      const replay = await request(root, secondRuntime, `/api/sessions/${id}/action`, jsonRequest(action));
      expect(replay.status).toBe(200);
      expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
      expect(await replay.json()).toEqual(receipt.status === "ok" ? receipt.value?.response : undefined);
      expect(modelCalls).toBe(1);
      expect(socket.sent).toHaveLength(0);
    } finally {
      GameSession.prototype.restoreOrdinarySessionSnapshot = originalRestore;
      for (const session of [...firstRuntime.registry.values(), ...secondRuntime.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("quarantines an expired holder, rejects its old publish fence, then permits an exact retry only after it settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-expiry-fence-"));
    let now = 0;
    const firstAdmission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"), { leaseTtlMs: 60_000, now: () => now });
    const secondAdmission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"), { leaseTtlMs: 60_000, now: () => now });
    const firstRuntime = runtime(root, firstAdmission); const secondRuntime = runtime(root, secondAdmission);
    const firstModel = deferred<Response>(); let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? firstModel.promise : completion("help"))) as unknown as typeof fetch;
    try {
      const id = await createAndHydrate(root, firstRuntime, secondRuntime);
      const socket = fakeSocket(); createWsClient(socket.ws, id, "player", "p1"); liveSockets.push(socket.ws);
      const firstAction = { input: "expired holder action", actionId: "ordinary-expired-holder-action-0001", expectedGeneration: 0 };
      const competingAction = { input: "must not take over by ttl", actionId: "ordinary-expired-holder-action-0002", expectedGeneration: 0 };
      const firstPromise = request(root, firstRuntime, `/api/sessions/${id}/action`, jsonRequest(firstAction));
      await eventually(() => calls === 1);
      now = 60_001;
      const competing = await request(root, secondRuntime, `/api/sessions/${id}/action`, jsonRequest(competingAction));
      const competingBody = await competing.json();
      expect(competing.status).toBe(503);
      expect(competingBody).toEqual({ code: "ordinary_action_quarantined", ordinaryGeneration: 0 });
      expect(calls).toBe(1);

      firstModel.resolve(completion("help"));
      const stale = await firstPromise; const staleBody = await stale.json();
      expect(stale.status).toBe(503);
      expect(staleBody).toEqual({ code: "ordinary_action_quarantined", ordinaryGeneration: 0 });
      const durableBeforeRetry = firstRuntime.dependencies.ordinarySnapshots!.read(id);
      expect(durableBeforeRetry.status).toBe("ok");
      if (durableBeforeRetry.status !== "ok") throw new Error("ordinary predecessor disappeared after a stale fence");
      expect(durableBeforeRetry.value.generation).toBe(0);
      expect(firstRuntime.dependencies.ordinarySnapshots!.findActionReceipt(id, firstAction.actionId)).toEqual({ status: "ok", value: null });
      expect(socket.sent).toHaveLength(0);

      const retry = await request(root, secondRuntime, `/api/sessions/${id}/action`, jsonRequest(firstAction));
      expect(retry.status).toBe(200);
      expect((await retry.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(1);
      expect(calls).toBe(2);
      expect(socket.sent).toHaveLength(1);
    } finally {
      firstModel.resolve(completion("help"));
      for (const session of [...firstRuntime.registry.values(), ...secondRuntime.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("quarantines an expired active lease in one bodyless operator recovery and deletes it only in the next", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-operator-recovery-"));
    let now = 0;
    const crashedAdmission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"), { leaseTtlMs: 60_000, now: () => now });
    const recoveryAdmission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"), { leaseTtlMs: 60_000, now: () => now });
    const current = runtime(root, recoveryAdmission); const hydration = runtime(root, recoveryAdmission);
    const operatorOwner = runtime(root, recoveryAdmission); const operatorHydration = runtime(root, recoveryAdmission);
    let modelCalls = 0;
    globalThis.fetch = (async () => { modelCalls++; return completion("help"); }) as unknown as typeof fetch;
    try {
      const id = await createAndHydrate(root, current, hydration);
      const abandoned = crashedAdmission.acquire({
        sessionId: id,
        expectedGeneration: 0,
        actionId: "ordinary-crashed-admission-action-0001",
        requestHash: "a".repeat(64),
      });
      expect(abandoned.status).toBe("acquired");

      const keeperRecovery = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" });
      expect(keeperRecovery.status).toBe(403);
      const activeRecovery = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" }, operator());
      expect(activeRecovery.status).toBe(503);
      expect(await activeRecovery.json()).toEqual({ code: "ordinary_action_busy", ordinaryGeneration: 0 });

      now = 60_001;
      const expiredActiveRecovery = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" }, operator());
      expect(expiredActiveRecovery.status).toBe(202);
      expect(expiredActiveRecovery.headers.get("Retry-After")).toBeNull();
      expect(await expiredActiveRecovery.json()).toEqual({
        status: "quarantined",
        code: "ordinary_action_admission_quarantined",
        ordinaryGeneration: 0,
      });
      expect(modelCalls).toBe(0);

      let bodyPulls = 0;
      const callerSelectedFence = new ReadableStream<Uint8Array>({
        pull(controller) {
          bodyPulls++;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ fence: "attacker", expectedGeneration: 0 })));
          controller.close();
        },
      }, { highWaterMark: 0 });
      const bodyfulRecovery = await request(root, current, `/api/sessions/${id}/action-admission/recover`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: callerSelectedFence,
      }, operator());
      expect(bodyfulRecovery.status).toBe(400);
      expect(await bodyfulRecovery.json()).toEqual({ code: "ordinary_action_recovery_body_forbidden" });
      expect(bodyPulls).toBe(0);

      const recovered = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" }, operator());
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ status: "recovered", code: "ordinary_action_admission_recovered" });
      const replacement = recoveryAdmission.acquire({
        sessionId: id,
        expectedGeneration: 0,
        actionId: "ordinary-replacement-fence-action-0002",
        requestHash: "d".repeat(64),
      });
      expect(replacement.status).toBe("acquired");
      if (abandoned.status !== "acquired" || replacement.status !== "acquired") throw new Error("ordinary recovery fence setup failed");
      let stalePublished = false;
      expect(abandoned.withActiveFence(() => { stalePublished = true; })).toMatchObject({ status: "refused" });
      abandoned.release();
      expect(stalePublished).toBe(false);
      expect(crashedAdmission.acquire({
        sessionId: id,
        expectedGeneration: 0,
        actionId: "ordinary-release-probe-action-0003",
        requestHash: "e".repeat(64),
      })).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_BUSY" });
      replacement.release();
      const action = await request(root, current, `/api/sessions/${id}/action`, jsonRequest({
        input: "works after explicit operator recovery", actionId: "ordinary-after-recovery-action-0004", expectedGeneration: 0,
      }));
      expect(action.status).toBe(200);
      expect((await action.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(1);
      expect(modelCalls).toBe(1);

      const operatorAuth = operator("operator:ordinary-session-owner");
      const operatorOwnedId = await createAndHydrate(root, operatorOwner, operatorHydration, operatorAuth);
      const operatorOwnedCrash = crashedAdmission.acquire({
        sessionId: operatorOwnedId,
        expectedGeneration: 0,
        actionId: "ordinary-operator-owned-crash-0005",
        requestHash: "c".repeat(64),
      });
      expect(operatorOwnedCrash.status).toBe("acquired");
      now = 120_002;
      const operatorOwnedQuarantine = await request(root, operatorOwner, `/api/sessions/${operatorOwnedId}/action-admission/recover`, { method: "POST" }, operator());
      expect(operatorOwnedQuarantine.status).toBe(202);
      expect(await operatorOwnedQuarantine.json()).toEqual({
        status: "quarantined",
        code: "ordinary_action_admission_quarantined",
        ordinaryGeneration: 0,
      });
      const operatorOwnedRecovery = await request(root, operatorOwner, `/api/sessions/${operatorOwnedId}/action-admission/recover`, { method: "POST" }, operator());
      expect(operatorOwnedRecovery.status).toBe(200);
      expect(await operatorOwnedRecovery.json()).toEqual({ status: "recovered", code: "ordinary_action_admission_recovered" });
    } finally {
      for (const session of [...current.registry.values(), ...hydration.registry.values(), ...operatorOwner.registry.values(), ...operatorHydration.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("keeps a future-generation expired active lease unchanged during bodyless operator recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-operator-generation-mismatch-"));
    let now = 0;
    const admission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"), { leaseTtlMs: 100, now: () => now });
    const current = runtime(root, admission); const hydration = runtime(root, admission);
    try {
      const id = await createAndHydrate(root, current, hydration);
      const future = admission.acquire({
        sessionId: id,
        expectedGeneration: 1,
        actionId: "ordinary-future-generation-active-0001",
        requestHash: "f".repeat(64),
      });
      expect(future.status).toBe("acquired");
      now = 101;

      const refused = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" }, operator());
      expect(refused.status).toBe(503);
      expect(refused.headers.get("Retry-After")).toBe("60");
      expect(await refused.json()).toEqual({ code: "ordinary_action_admission_unavailable", ordinaryGeneration: 0 });

      const database = new Database(admission.file);
      try {
        expect(database.query("SELECT expected_generation, state FROM ordinary_action_admission_leases WHERE session_id = ?").get(id)).toEqual({
          expected_generation: 1,
          state: "active",
        });
      } finally { database.close(); }
    } finally {
      for (const session of [...current.registry.values(), ...hydration.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("recovers a short-TTL lease after the exact holding child is killed without a player probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-operator-process-crash-"));
    const admission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"), { leaseTtlMs: 100 });
    const current = runtime(root, admission); const hydration = runtime(root, admission);
    let child: ReturnType<typeof spawnCrashLeaseProcess> | undefined; let modelCalls = 0;
    globalThis.fetch = (async () => { modelCalls++; return completion("help"); }) as unknown as typeof fetch;
    try {
      const id = await createAndHydrate(root, current, hydration);
      child = spawnCrashLeaseProcess(root, id);
      expect(await child.next()).toMatchObject({ event: "crash-lease-acquired" });
      // This calls only the specific Bun child handle created above. It neither
      // enumerates PIDs nor signals a process outside this test fixture.
      await child.killAndDrain();
      await Bun.sleep(150);

      const quarantined = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" }, operator());
      expect(quarantined.status).toBe(202);
      expect(quarantined.headers.get("Retry-After")).toBeNull();
      expect(await quarantined.json()).toEqual({
        status: "quarantined",
        code: "ordinary_action_admission_quarantined",
        ordinaryGeneration: 0,
      });
      const recovered = await request(root, current, `/api/sessions/${id}/action-admission/recover`, { method: "POST" }, operator());
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ status: "recovered", code: "ordinary_action_admission_recovered" });
      expect(modelCalls).toBe(0);

      const replacement = admission.acquire({
        sessionId: id,
        expectedGeneration: 0,
        actionId: "ordinary-process-crash-replacement-0002",
        requestHash: "d".repeat(64),
      });
      expect(replacement.status).toBe("acquired");
      if (replacement.status === "acquired") replacement.release();
    } finally {
      await child?.dispose();
      for (const session of [...current.registry.values(), ...hydration.registry.values()]) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
