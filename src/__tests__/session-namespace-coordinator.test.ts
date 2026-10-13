import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import {
  SessionNamespaceCoordinator,
  SessionNamespaceFailure,
  type DurableSessionIdentity,
  type LegacyAdoptCommittedSessionNamespaceInput,
  type ReconcileObservedSessionNamespaceInput,
  type ReservationHandle,
  type RuntimeSessionKind,
} from "../api/session-namespace-coordinator";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";

const roots = new Set<string>();
const child = join(import.meta.dir, "session-namespace-coordinator-process-child.ts");
const httpCreateChild = join(import.meta.dir, "session-namespace-http-create-child.ts");
const compiledHttpCreateChild = join(import.meta.dir, "session-namespace-compiled-http-create-child.ts");

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "session-namespace-"));
  roots.add(value);
  return value;
}

function identity(letter = "a", generation = 0): DurableSessionIdentity {
  return { hash: letter.repeat(64), generation, format: "runtime-session-v1" };
}

/** Compile-only contract: ordinary identity observations cannot omit their binding. */
export function assertReconcileObservedInputTypes(): void {
  const accepts = (_input: ReconcileObservedSessionNamespaceInput): void => {};
  const legacyAccepts = (_input: LegacyAdoptCommittedSessionNamespaceInput): void => {};
  accepts({
    sessionId: "ordinary-typed", kind: "ordinary", observedIdentity: identity("a", 1),
    observedPredecessorHash: "b".repeat(64),
  });
  accepts({ sessionId: "ordinary-g0-typed", kind: "ordinary", observedIdentity: identity("a", 0), observedPredecessorHash: null });
  accepts({ sessionId: "compiled-typed", kind: "compiled", observedIdentity: identity("a", 1) });
  accepts({ sessionId: "reason-typed", kind: "ordinary", reasonCode: "ORDINARY_LOCATOR_INVALID" });
  legacyAccepts({ sessionId: "legacy-typed", kind: "ordinary", observedIdentity: identity("a", 4) });

  // @ts-expect-error ordinary identity observations require an own predecessor field
  accepts({ sessionId: "ordinary-omitted", kind: "ordinary", observedIdentity: identity("a", 1) });
  // @ts-expect-error compiled identity observations never carry ordinary predecessor authority
  accepts({ sessionId: "compiled-predecessor", kind: "compiled", observedIdentity: identity("a", 1), observedPredecessorHash: "b".repeat(64) });
  // @ts-expect-error reason-only reconciliation never carries an identity predecessor field
  accepts({ sessionId: "reason-predecessor", kind: "ordinary", reasonCode: "ORDINARY_LOCATOR_INVALID", observedPredecessorHash: "b".repeat(64) });
  // @ts-expect-error legacy adoption never carries ordinary predecessor authority
  legacyAccepts({ sessionId: "legacy-predecessor", kind: "ordinary", observedIdentity: identity("a", 4), observedPredecessorHash: "b".repeat(64) });
}

function failureOf(action: () => unknown): SessionNamespaceFailure {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SessionNamespaceFailure);
  return failure as SessionNamespaceFailure;
}

function foreign(handle: ReservationHandle): ReservationHandle {
  return { ...handle, token: "x".repeat(handle.token.length) };
}

async function reserveInChild(rootPath: string, sessionId: string, kind: RuntimeSessionKind, leaseMs?: number, action: "reserve" | "adopt" = "reserve"): Promise<{ status: string; code?: string; kind?: RuntimeSessionKind }> {
  const childProcess = Bun.spawn([process.execPath, child], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      SESSION_NAMESPACE_ROOT: rootPath,
      SESSION_NAMESPACE_ID: sessionId,
      SESSION_NAMESPACE_KIND: kind,
      SESSION_NAMESPACE_ACTION: action,
      ...(leaseMs === undefined ? {} : { SESSION_NAMESPACE_LEASE_MS: String(leaseMs) }),
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    childProcess.exited,
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`session namespace child failed: ${stderr}`);
  return JSON.parse(stdout.trim()) as { status: string; code?: string; kind?: RuntimeSessionKind };
}

interface HeldPublisher {
  next(): Promise<{ event: "ready" | "result"; result?: { status: string; kind: RuntimeSessionKind } }>;
  release(): void;
  finish(): Promise<{ status: string; kind: RuntimeSessionKind }>;
}

function spawnHeldPublisher(rootPath: string, sessionId: string, kind: RuntimeSessionKind, marker: string): HeldPublisher {
  const childProcess = Bun.spawn([process.execPath, child], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      SESSION_NAMESPACE_ROOT: rootPath,
      SESSION_NAMESPACE_ID: sessionId,
      SESSION_NAMESPACE_KIND: kind,
      SESSION_NAMESPACE_ACTION: "publish",
      SESSION_NAMESPACE_HOLD_PUBLICATION: "1",
      SESSION_NAMESPACE_MARKER: marker,
    },
  });
  const events: Array<{ event: "ready" | "result"; result?: { status: string; kind: RuntimeSessionKind } }> = [];
  let wake: (() => void) | undefined;
  let stdout = "";
  let stderr = "";
  let line = "";
  let final: { status: string; kind: RuntimeSessionKind } | undefined;
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of childProcess.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      stdout += text;
      line += text;
      for (;;) {
        const end = line.indexOf("\n");
        if (end < 0) break;
        const raw = line.slice(0, end); line = line.slice(end + 1);
        try {
          const event = JSON.parse(raw) as { event: "ready" | "result"; result?: { status: string; kind: RuntimeSessionKind } };
          if (event.event === "result") final = event.result;
          events.push(event); wake?.(); wake = undefined;
        } catch { /* finish reports unparseable child output */ }
      }
    }
  })();
  const stderrDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of childProcess.stderr) stderr += decoder.decode(chunk, { stream: true });
  })();
  return {
    async next() {
      while (!events.length) await new Promise<void>((resolve) => { wake = resolve; });
      return events.shift()!;
    },
    release() {
      const stdin = childProcess.stdin;
      if (!stdin || typeof stdin === "number") throw new Error("held publisher has no stdin");
      stdin.write("x"); stdin.end();
    },
    async finish() {
      const exit = await childProcess.exited;
      await Promise.all([stdoutDrain, stderrDrain]);
      if (exit !== 0 || !final) throw new Error(`held publisher failed (${exit}): ${stdout} ${stderr}`);
      return final;
    },
  };
}

type HttpCreateEvent = { event: "ready" | "result"; result?: { status: number; code?: string; factoryCalls: number; openingCalls: number } };
interface HeldHttpCreate {
  next(): Promise<HttpCreateEvent>;
  release(): void;
  finish(): Promise<NonNullable<HttpCreateEvent["result"]>>;
  kill(): Promise<void>;
}

function spawnHeldHttpCreate(rootPath: string, sessionId: string, holdFactory: boolean, owner: string): HeldHttpCreate {
  const childProcess = Bun.spawn([process.execPath, httpCreateChild], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, SESSION_NAMESPACE_HTTP_ROOT: rootPath, SESSION_NAMESPACE_HTTP_ID: sessionId, SESSION_NAMESPACE_HTTP_OWNER: owner, ...(holdFactory ? { SESSION_NAMESPACE_HTTP_HOLD_FACTORY: "1" } : {}) },
  });
  const events: HttpCreateEvent[] = [];
  let wake: (() => void) | undefined;
  let stdout = "", stderr = "", line = "";
  let result: HttpCreateEvent["result"];
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of childProcess.stdout) {
      const text = decoder.decode(chunk, { stream: true }); stdout += text; line += text;
      for (;;) {
        const end = line.indexOf("\n"); if (end < 0) break;
        const raw = line.slice(0, end); line = line.slice(end + 1);
        try { const event = JSON.parse(raw) as HttpCreateEvent; if (event.event === "result") result = event.result; events.push(event); wake?.(); wake = undefined; }
        catch { /* finish reports malformed child output */ }
      }
    }
  })();
  const stderrDrain = (async () => { const decoder = new TextDecoder(); for await (const chunk of childProcess.stderr) stderr += decoder.decode(chunk, { stream: true }); })();
  const waitForEvent = async (): Promise<HttpCreateEvent> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => { while (!events.length) await new Promise<void>((resolve) => { wake = resolve; }); return events.shift()!; })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out waiting for namespace HTTP child event")), 10_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  return {
    next: waitForEvent,
    release() { const stdin = childProcess.stdin; if (!stdin || typeof stdin === "number") throw new Error("namespace HTTP child has no stdin"); stdin.write("x"); stdin.end(); },
    async finish() {
      const exit = await childProcess.exited; await Promise.all([stdoutDrain, stderrDrain]);
      if (exit !== 0 || !result) throw new Error(`namespace HTTP child failed (${exit}): ${stdout} ${stderr}`);
      return result;
    },
    async kill() { childProcess.kill(); await childProcess.exited; await Promise.all([stdoutDrain, stderrDrain]); },
  };
}

type CompiledHttpCreateEvent = { event: "ready" | "result"; result?: { status: number; code?: string; loadCalls: number } };
interface HeldCompiledHttpCreate {
  next(): Promise<CompiledHttpCreateEvent>;
  release(): void;
  finish(): Promise<NonNullable<CompiledHttpCreateEvent["result"]>>;
  kill(): Promise<void>;
}

function spawnHeldCompiledHttpCreate(rootPath: string, sessionId: string, bundleId: string, holdFactory: boolean, owner: string): HeldCompiledHttpCreate {
  const childProcess = Bun.spawn([process.execPath, compiledHttpCreateChild], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, SESSION_NAMESPACE_HTTP_ROOT: rootPath, SESSION_NAMESPACE_HTTP_ID: sessionId, SESSION_NAMESPACE_HTTP_BUNDLE_ID: bundleId, SESSION_NAMESPACE_HTTP_OWNER: owner, ...(holdFactory ? { SESSION_NAMESPACE_HTTP_HOLD_FACTORY: "1" } : {}) },
  });
  const events: CompiledHttpCreateEvent[] = [];
  let wake: (() => void) | undefined;
  let stdout = "", stderr = "", line = "";
  let result: CompiledHttpCreateEvent["result"];
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of childProcess.stdout) {
      const text = decoder.decode(chunk, { stream: true }); stdout += text; line += text;
      for (;;) {
        const end = line.indexOf("\n"); if (end < 0) break;
        const raw = line.slice(0, end); line = line.slice(end + 1);
        try { const event = JSON.parse(raw) as CompiledHttpCreateEvent; if (event.event === "result") result = event.result; events.push(event); wake?.(); wake = undefined; }
        catch { /* finish reports malformed child output */ }
      }
    }
  })();
  const stderrDrain = (async () => { const decoder = new TextDecoder(); for await (const chunk of childProcess.stderr) stderr += decoder.decode(chunk, { stream: true }); })();
  const next = async (): Promise<CompiledHttpCreateEvent> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => { while (!events.length) await new Promise<void>((resolve) => { wake = resolve; }); return events.shift()!; })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out waiting for compiled namespace HTTP child event")), 10_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  return {
    next,
    release() { const stdin = childProcess.stdin; if (!stdin || typeof stdin === "number") throw new Error("compiled namespace HTTP child has no stdin"); stdin.write("x"); stdin.end(); },
    async finish() { const exit = await childProcess.exited; await Promise.all([stdoutDrain, stderrDrain]); if (exit !== 0 || !result) throw new Error(`compiled namespace HTTP child failed (${exit}): ${stdout} ${stderr}`); return result; },
    async kill() { childProcess.kill(); await childProcess.exited; await Promise.all([stdoutDrain, stderrDrain]); },
  };
}

describe("SessionNamespaceCoordinator", () => {
  it("makes two fresh Bun ordinary creators share one pre-factory reservation and isolates the loser staging root", async () => {
    const dir = root(); const id = "12345678-1234-4123-8123-123456789abc";
    const first = spawnHeldHttpCreate(dir, id, true, "namespace-http-first-owner");
    let firstFinished = false;
    try {
      expect(await first.next()).toEqual({ event: "ready" });
      const second = spawnHeldHttpCreate(dir, id, false, "namespace-http-second-owner");
      let secondFinished = false;
      try {
        const loser = await second.finish(); secondFinished = true;
        expect(loser).toMatchObject({ status: 503, code: "SESSION_NAMESPACE_CONFLICT", factoryCalls: 0, openingCalls: 0 });
      } finally { if (!secondFinished) await second.kill(); }
      first.release();
      const winner = await first.finish(); firstFinished = true;
      // The committed reconstruction can instantiate a cheap final session,
      // but exactly one process may reach the opening/model boundary.
      expect(winner).toMatchObject({ status: 201, openingCalls: 1 });
      expect(new SessionNamespaceCoordinator(join(dir, "sessions")).read(id)).toMatchObject({ kind: "ordinary", state: "committed" });
    } finally { if (!firstFinished) await first.kill(); }
  }, 20_000);

  it("makes two fresh Bun compiled creators reject the loser before its load/model boundary", async () => {
    const dir = root(); const id = "12345678-1234-4123-8123-123456789abc";
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const bundle = saveTrustedFixtureBundle(catalog, fixture);
    const first = spawnHeldCompiledHttpCreate(dir, id, bundle.id, true, "operator:namespace-compiled-first");
    let firstFinished = false;
    try {
      expect(await first.next()).toEqual({ event: "ready" });
      const second = spawnHeldCompiledHttpCreate(dir, id, bundle.id, false, "operator:namespace-compiled-second");
      let secondFinished = false;
      try {
        const loser = await second.finish(); secondFinished = true;
        expect(loser).toMatchObject({ status: 409, code: "SESSION_NAMESPACE_CONFLICT", loadCalls: 0 });
      } finally { if (!secondFinished) await second.kill(); }
      first.release();
      const winner = await first.finish(); firstFinished = true;
      expect(winner).toMatchObject({ status: 201, loadCalls: 1 });
      expect(new SessionNamespaceCoordinator(join(dir, "careers", ".runtime-session-namespace")).read(id)).toMatchObject({ kind: "compiled", state: "committed" });
    } finally { if (!firstFinished) await first.kill(); }
  }, 30_000);

  it("reserves before g0 construction, then stores only its prepared durable identity", () => {
    const dir = root();
    const coordinator = new SessionNamespaceCoordinator(dir);
    let factoryCalls = 0;
    const reservation = coordinator.reserve({ sessionId: "alpha", kind: "ordinary" });

    expect(reservation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reservation.token).not.toContain("alpha");
    expect(coordinator.read("alpha")).toEqual(expect.objectContaining({
      sessionId: "alpha", kind: "ordinary", state: "reserved", expectedIdentity: null,
    }));
    expect(coordinator.read("alpha")).not.toHaveProperty("token");
    const g0 = () => { factoryCalls++; return identity(); };
    expect(factoryCalls).toBe(0);
    const prepared = coordinator.prepare({ reservation, expectedIdentity: g0() });
    expect(factoryCalls).toBe(1);
    expect(prepared.expectedIdentity).toEqual(identity());

    const database = new Database(coordinator.file, { readonly: true });
    const columns = database.query<{ name: string }, []>("PRAGMA table_info(session_namespace_entries)").all().map((row) => row.name);
    database.close();
    expect(columns).toEqual(expect.arrayContaining(["session_id", "expected_hash", "expected_generation", "expected_format", "reservation_token_hash"]));
    expect(columns).not.toEqual(expect.arrayContaining(["snapshot", "access", "session_access", "snapshot_json"]));
  });

  it("never reuses committed, abandoned, or quarantined IDs", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const committed = coordinator.reserve({ sessionId: "committed", kind: "ordinary" });
    const prepared = coordinator.prepare({ reservation: committed, expectedIdentity: identity() });
    coordinator.commit({ reservation: prepared, observedIdentity: identity() });
    expect(failureOf(() => coordinator.reserve({ sessionId: "committed", kind: "ordinary" })).code)
      .toBe("SESSION_NAMESPACE_CONFLICT");

    const abandoned = coordinator.reserve({ sessionId: "abandoned", kind: "ordinary" });
    coordinator.abandon({ reservation: abandoned, reasonCode: "OWNER_ABORTED" });
    expect(failureOf(() => coordinator.reserve({ sessionId: "abandoned", kind: "compiled" })).code)
      .toBe("SESSION_NAMESPACE_CONFLICT");

    const quarantined = coordinator.reserve({ sessionId: "quarantined", kind: "compiled" });
    const quarantinedPrepared = coordinator.prepare({ reservation: quarantined, expectedIdentity: identity("c") });
    expect(failureOf(() => coordinator.commit({ reservation: quarantinedPrepared, observedIdentity: identity("d") })).code)
      .toBe("SESSION_NAMESPACE_IDENTITY_MISMATCH");
    expect(coordinator.read("quarantined")).toMatchObject({ state: "quarantined", reasonCode: "DURABLE_IDENTITY_MISMATCH" });
    expect(failureOf(() => coordinator.reserve({ sessionId: "quarantined", kind: "ordinary" })).code)
      .toBe("SESSION_NAMESPACE_CONFLICT");
  });

  it("uses fencing and owner-only release, retaining the abandoned tombstone", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const reserved = coordinator.reserve({ sessionId: "fenced", kind: "ordinary" });
    const renewed = coordinator.renew({ reservation: reserved, leaseMs: 1_000 });
    expect(renewed.fencingToken).toBe(reserved.fencingToken + 1);
    expect(renewed.token).not.toBe(reserved.token);
    expect(failureOf(() => coordinator.prepare({ reservation: reserved, expectedIdentity: identity() })).code)
      .toBe("SESSION_NAMESPACE_FENCED");
    expect(failureOf(() => coordinator.prepare({ reservation: { ...renewed, token: reserved.token }, expectedIdentity: identity() })).code)
      .toBe("SESSION_NAMESPACE_FENCED");
    expect(failureOf(() => coordinator.release({ reservation: foreign(renewed), reasonCode: "NOT_OWNER" })).code)
      .toBe("SESSION_NAMESPACE_FENCED");
    expect(coordinator.read("fenced")).toMatchObject({ state: "reserved" });

    coordinator.release({ reservation: renewed, reasonCode: "OWNER_RELEASED" });
    expect(coordinator.read("fenced")).toMatchObject({ state: "abandoned", reasonCode: "OWNER_RELEASED" });
    expect(coordinator.list({ state: "abandoned" }).records.map((record) => record.sessionId)).toContain("fenced");
  });

  it("quarantines instead of committing when the caller cannot prove the exact prepared identity", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const reserved = coordinator.reserve({ sessionId: "pointer", kind: "compiled" });
    const prepared = coordinator.prepare({ reservation: reserved, expectedIdentity: identity("e", 4) });
    expect(failureOf(() => coordinator.commit({ reservation: prepared, observedIdentity: identity("e", 5) })).code)
      .toBe("SESSION_NAMESPACE_IDENTITY_MISMATCH");
    expect(coordinator.read("pointer")).toMatchObject({ state: "quarantined", reasonCode: "DURABLE_IDENTITY_MISMATCH" });
  });

  it("persists fail-closed terminal records for prepared identity and publication-shape violations", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const identityMismatch = coordinator.prepare({
      reservation: coordinator.reserve({ sessionId: "prepared-identity-mismatch", kind: "ordinary" }),
      expectedIdentity: identity("a", 0),
    });
    expect(failureOf(() => coordinator.prepare({
      reservation: identityMismatch,
      expectedIdentity: identity("b", 0),
    })).code).toBe("SESSION_NAMESPACE_IDENTITY_MISMATCH");
    expect(coordinator.read("prepared-identity-mismatch")).toMatchObject({
      state: "quarantined", reasonCode: "PREPARED_IDENTITY_MISMATCH",
    });

    const invalidObservation = coordinator.prepare({
      reservation: coordinator.reserve({ sessionId: "invalid-publication-observation", kind: "compiled" }),
      expectedIdentity: identity("c", 0),
    });
    expect(failureOf(() => coordinator.publishPrepared({
      reservation: invalidObservation,
      publish: (() => ({ status: "published" })) as unknown as () => never,
    })).code).toBe("SESSION_NAMESPACE_STORAGE_FAILED");
    expect(coordinator.read("invalid-publication-observation")).toMatchObject({
      state: "quarantined", reasonCode: "INVALID_PUBLICATION_OBSERVATION",
    });
  });

  it("advances a committed current identity only by an exact generation CAS, preserving stale-writer fencing", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const g0 = identity("a", 0);
    const g1 = identity("b", 1);
    const g2 = identity("c", 2);
    coordinator.adoptCommitted({ sessionId: "successor", kind: "ordinary", observedIdentity: g0 });

    expect(coordinator.advanceCommitted({
      sessionId: "successor", kind: "ordinary", previousIdentity: g0, observedIdentity: g1,
    })).toMatchObject({ state: "committed", kind: "ordinary", expectedIdentity: g1 });
    // Retrying an acknowledgement after the durable store has already moved
    // current is safe, while a g0 writer can neither regress nor quarantine it.
    expect(coordinator.advanceCommitted({
      sessionId: "successor", kind: "ordinary", previousIdentity: g0, observedIdentity: g1,
    })).toMatchObject({ state: "committed", expectedIdentity: g1 });
    expect(failureOf(() => coordinator.advanceCommitted({
      sessionId: "successor", kind: "ordinary", previousIdentity: g0, observedIdentity: g2,
    })).code).toBe("SESSION_NAMESPACE_IDENTITY_MISMATCH");
    expect(coordinator.read("successor")).toMatchObject({ state: "committed", expectedIdentity: g1 });

    expect(coordinator.advanceCommitted({
      sessionId: "successor", kind: "ordinary", previousIdentity: g1, observedIdentity: g2,
    })).toMatchObject({ state: "committed", expectedIdentity: g2 });
    expect(failureOf(() => coordinator.advanceCommitted({
      sessionId: "successor", kind: "compiled", previousIdentity: g1, observedIdentity: g2,
    })).code).toBe("SESSION_NAMESPACE_CONFLICT");
    expect(coordinator.read("successor")).toMatchObject({ state: "committed", kind: "ordinary", expectedIdentity: g2 });
  });

  it("startup reconciliation recovers only the exact next same-kind pointer after a lost gN acknowledgement", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const g0 = identity("a", 0); const g1 = identity("b", 1); const g3 = identity("c", 3);
    const prepared = coordinator.prepare({ reservation: coordinator.reserve({ sessionId: "reconcile-successor", kind: "ordinary" }), expectedIdentity: g0 });
    coordinator.commit({ reservation: prepared, observedIdentity: g0 });
    expect(coordinator.reconcileObserved({ sessionId: "reconcile-successor", kind: "ordinary", observedIdentity: g1, observedPredecessorHash: g0.hash }))
      .toMatchObject({ state: "committed", expectedIdentity: g1 });
    expect(coordinator.reconcileObserved({ sessionId: "reconcile-successor", kind: "ordinary", observedIdentity: g3, observedPredecessorHash: g1.hash }))
      .toMatchObject({ state: "quarantined", reasonCode: "OBSERVED_COMMITTED_CONFLICT" });
  });

  it("requires a closed own predecessor binding before ordinary startup reconciliation advances a committed pointer", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const g0 = identity("a", 0);
    const g1 = identity("b", 1);
    const seed = (sessionId: string) => {
      const prepared = coordinator.prepare({
        reservation: coordinator.reserve({ sessionId, kind: "ordinary" }),
        expectedIdentity: g0,
      });
      coordinator.commit({ reservation: prepared, observedIdentity: g0 });
    };
    const rejected = (sessionId: string, input: object) => {
      seed(sessionId);
      expect(failureOf(() => coordinator.reconcileObserved(input as never)).code)
        .toBe("SESSION_NAMESPACE_STORAGE_FAILED");
      expect(coordinator.read(sessionId)).toMatchObject({ state: "committed", expectedIdentity: g0 });
    };
    const rejectedBeforeTransaction = (sessionId: string, action: () => unknown) => {
      expect(failureOf(action).code).toBe("SESSION_NAMESPACE_STORAGE_FAILED");
      expect(coordinator.read(sessionId)).toBeUndefined();
    };

    // An ordinary successor must not be accepted merely because the caller
    // omitted the optional-looking field or supplied `undefined`.
    rejected("ordinary-predecessor-omitted", {
      sessionId: "ordinary-predecessor-omitted", kind: "ordinary", observedIdentity: g1,
    });
    rejected("ordinary-predecessor-undefined", {
      sessionId: "ordinary-predecessor-undefined", kind: "ordinary", observedIdentity: g1,
      observedPredecessorHash: undefined,
    });

    const accessorInput: Record<string, unknown> = {
      sessionId: "ordinary-predecessor-accessor", kind: "ordinary", observedIdentity: g1,
    };
    Object.defineProperty(accessorInput, "observedPredecessorHash", {
      enumerable: true,
      get: () => g0.hash,
    });
    rejected("ordinary-predecessor-accessor", accessorInput);

    const prototypeInput = Object.assign(Object.create({ observedPredecessorHash: g0.hash }), {
      sessionId: "ordinary-predecessor-prototype", kind: "ordinary", observedIdentity: g1,
    });
    rejected("ordinary-predecessor-prototype", prototypeInput);

    // Runtime validation remains the boundary for values from disk or an
    // explicit type escape: the discriminator alone cannot prove g0/gN.
    rejectedBeforeTransaction("ordinary-g0-hash", () => coordinator.reconcileObserved({
      sessionId: "ordinary-g0-hash", kind: "ordinary", observedIdentity: g0, observedPredecessorHash: g0.hash,
    } as never));
    rejectedBeforeTransaction("ordinary-g1-null", () => coordinator.reconcileObserved({
      sessionId: "ordinary-g1-null", kind: "ordinary", observedIdentity: g1, observedPredecessorHash: null,
    } as never));
    rejectedBeforeTransaction("compiled-predecessor-runtime", () => coordinator.reconcileObserved({
      sessionId: "compiled-predecessor-runtime", kind: "compiled", observedIdentity: g1, observedPredecessorHash: g0.hash,
    } as never));
    rejectedBeforeTransaction("reason-predecessor-runtime", () => coordinator.reconcileObserved({
      sessionId: "reason-predecessor-runtime", kind: "ordinary", reasonCode: "ORDINARY_LOCATOR_INVALID", observedPredecessorHash: g0.hash,
    } as never));
    rejectedBeforeTransaction("legacy-predecessor-runtime", () => coordinator.adoptCommitted({
      sessionId: "legacy-predecessor-runtime", kind: "ordinary", observedIdentity: g1, observedPredecessorHash: g0.hash,
    } as never));

    // The ordinary store supplies a literal own binding for gN, including the
    // explicit no-predecessor marker for its first durable generation.
    seed("ordinary-predecessor-valid");
    expect(coordinator.reconcileObserved({
      sessionId: "ordinary-predecessor-valid", kind: "ordinary", observedIdentity: g1,
      observedPredecessorHash: g0.hash,
    })).toMatchObject({ state: "committed", expectedIdentity: g1 });
    expect(coordinator.reconcileObserved({
      sessionId: "ordinary-g0-explicit", kind: "ordinary", observedIdentity: g0,
      observedPredecessorHash: null,
    })).toMatchObject({ state: "committed", expectedIdentity: g0 });

    // Compiled durable identity has its own startup contract and remains
    // independent of ordinary envelope predecessor binding.
    const compiledPrepared = coordinator.prepare({
      reservation: coordinator.reserve({ sessionId: "compiled-no-ordinary-predecessor", kind: "compiled" }),
      expectedIdentity: g0,
    });
    coordinator.commit({ reservation: compiledPrepared, observedIdentity: g0 });
    expect(coordinator.reconcileObserved({
      sessionId: "compiled-no-ordinary-predecessor", kind: "compiled", observedIdentity: g1,
    })).toMatchObject({ state: "committed", expectedIdentity: g1 });

    // Conflict-reason observations and explicit legacy adoption do not need
    // an ordinary successor binding, but legacy adoption cannot advance one.
    expect(coordinator.reconcileObserved({
      sessionId: "ordinary-reason", kind: "ordinary", reasonCode: "ORDINARY_LOCATOR_INVALID",
    })).toMatchObject({ state: "quarantined", reasonCode: "ORDINARY_LOCATOR_INVALID" });
    expect(coordinator.adoptCommitted({
      sessionId: "ordinary-legacy-adopt", kind: "ordinary", observedIdentity: identity("c", 4),
    })).toMatchObject({ state: "committed", expectedIdentity: identity("c", 4) });
    seed("ordinary-legacy-no-advance");
    expect(coordinator.adoptCommitted({
      sessionId: "ordinary-legacy-no-advance", kind: "ordinary", observedIdentity: g1,
    })).toMatchObject({ state: "quarantined", reasonCode: "OBSERVED_COMMITTED_CONFLICT" });
  });

  it("holds the namespace publication fence through synchronous store publication and exact readback", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const reserved = coordinator.reserve({ sessionId: "publication", kind: "ordinary" });
    const prepared = coordinator.prepare({ reservation: reserved, expectedIdentity: identity("b", 1) });
    let storeWrites = 0;
    expect(failureOf(() => coordinator.publishPrepared({
      reservation: { ...prepared, expectedIdentity: identity("c", 1) },
      publish: () => { storeWrites++; return { status: "not-published" }; },
    })).code).toBe("SESSION_NAMESPACE_FENCED");
    expect(storeWrites).toBe(0);
    const published = coordinator.publishPrepared({
      reservation: prepared,
      publish() {
        storeWrites++;
        return { status: "published", observedIdentity: identity("b", 1) };
      },
    });
    expect(storeWrites).toBe(1);
    expect(published).toMatchObject({ status: "committed", record: { state: "committed", expectedIdentity: identity("b", 1) } });
  });

  it("issues a bound one-shot permit for g0 and gN store publication", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const g0 = identity("a", 0);
    const g1 = identity("b", 1);
    const prepared = coordinator.prepare({
      reservation: coordinator.reserve({ sessionId: "permit-successor", kind: "ordinary" }),
      expectedIdentity: g0,
    });
    let g0Permit: import("../api/session-namespace-coordinator").SessionNamespacePublicationPermit | undefined;
    expect(coordinator.publishPrepared({
      reservation: prepared,
      publish: (permit) => {
        g0Permit = permit;
        coordinator.consumePublicationPermit(permit, {
          kind: "ordinary", sessionId: "permit-successor", fencingToken: prepared.fencingToken,
          previousIdentity: null, nextIdentity: g0,
        });
        return { status: "published", observedIdentity: g0 };
      },
    })).toMatchObject({ status: "committed", record: { expectedIdentity: g0 } });
    expect(failureOf(() => coordinator.consumePublicationPermit(g0Permit!, {
      kind: "ordinary", sessionId: "permit-successor", fencingToken: prepared.fencingToken,
      previousIdentity: null, nextIdentity: g0,
    })).code).toBe("SESSION_NAMESPACE_FENCED");

    let g1Permit: import("../api/session-namespace-coordinator").SessionNamespacePublicationPermit | undefined;
    expect(coordinator.publishCommitted({
      kind: "ordinary", sessionId: "permit-successor", previousIdentity: g0, nextIdentity: g1,
      publish: (permit) => {
        g1Permit = permit;
        // The prior g0 permit/replay and any forged expectation are rejected,
        // while only this g1 capability can publish the exact successor.
        expect(failureOf(() => coordinator.consumePublicationPermit(g0Permit!, {
          kind: "ordinary", sessionId: "permit-successor", fencingToken: permit.fencingToken,
          previousIdentity: g0, nextIdentity: g1,
        })).code).toBe("SESSION_NAMESPACE_FENCED");
        coordinator.consumePublicationPermit(permit, {
          kind: "ordinary", sessionId: "permit-successor", fencingToken: permit.fencingToken,
          previousIdentity: g0, nextIdentity: g1,
        });
        return { status: "published", observedIdentity: g1 };
      },
    })).toMatchObject({ state: "committed", expectedIdentity: g1 });
    expect(failureOf(() => coordinator.consumePublicationPermit(g1Permit!, {
      kind: "ordinary", sessionId: "permit-successor", fencingToken: g1Permit!.fencingToken,
      previousIdentity: g0, nextIdentity: g1,
    })).code).toBe("SESSION_NAMESPACE_FENCED");
  });

  it("distinguishes no-publication from indeterminate publication and recovers exact crash-window evidence", () => {
    const dir = root();
    const coordinator = new SessionNamespaceCoordinator(dir);
    const noPublication = coordinator.prepare({
      reservation: coordinator.reserve({ sessionId: "no-publication", kind: "ordinary" }),
      expectedIdentity: identity("c", 2),
    });
    expect(coordinator.publishPrepared({ reservation: noPublication, publish: () => ({ status: "not-published" }) }))
      .toMatchObject({ status: "not-published" });
    expect(coordinator.read("no-publication")).toMatchObject({ state: "prepared", expectedIdentity: identity("c", 2) });

    const crashWindow = coordinator.prepare({
      reservation: coordinator.reserve({ sessionId: "crash-window", kind: "compiled" }),
      expectedIdentity: identity("d", 3),
    });
    let durableIdentity: DurableSessionIdentity | undefined;
    expect(coordinator.publishPrepared({
      reservation: crashWindow,
      publish() {
        durableIdentity = identity("d", 3); // store publication completed before namespace response/commit certainty
        throw new Error("lost response after durable write");
      },
    })).toMatchObject({ status: "indeterminate" });
    expect(coordinator.read("crash-window")).toMatchObject({ state: "prepared" });
    expect(new SessionNamespaceCoordinator(dir).reconcileObserved({
      sessionId: "crash-window", kind: "compiled", observedIdentity: durableIdentity!,
    })).toMatchObject({ state: "committed", expectedIdentity: identity("d", 3) });

    const explicitUnknown = coordinator.prepare({
      reservation: coordinator.reserve({ sessionId: "explicit-unknown", kind: "ordinary" }),
      expectedIdentity: identity("e", 3),
    });
    expect(coordinator.publishPrepared({ reservation: explicitUnknown, publish: () => ({ status: "indeterminate" }) }))
      .toMatchObject({ status: "indeterminate" });
    expect(new SessionNamespaceCoordinator(dir).reconcileObserved({
      sessionId: "explicit-unknown", kind: "compiled", observedIdentity: identity("e", 3),
    })).toMatchObject({ state: "quarantined", kind: "ordinary", reasonCode: "OBSERVED_PREPARED_CONFLICT" });
  });

  it("never publishes for a stale or expired owner, quarantines mismatch, and rejects namespace re-entry below the fence", () => {
    let now = 10_000;
    const coordinator = new SessionNamespaceCoordinator(root(), { now: () => now });
    const stale = coordinator.prepare({ reservation: coordinator.reserve({ sessionId: "stale-publication", kind: "ordinary" }), expectedIdentity: identity("e", 4) });
    const renewed = coordinator.renew({ reservation: stale, leaseMs: 10 });
    let called = false;
    expect(failureOf(() => coordinator.publishPrepared({ reservation: stale, publish: () => { called = true; return { status: "not-published" }; } })).code)
      .toBe("SESSION_NAMESPACE_FENCED");
    expect(called).toBe(false);

    now += 10;
    expect(failureOf(() => coordinator.publishPrepared({ reservation: renewed, publish: () => { called = true; return { status: "not-published" }; } })).code)
      .toBe("SESSION_NAMESPACE_LEASE_EXPIRED");
    expect(called).toBe(false);
    expect(coordinator.read("stale-publication")).toMatchObject({ state: "abandoned", reasonCode: "LEASE_EXPIRED" });

    const mismatch = coordinator.prepare({ reservation: coordinator.reserve({ sessionId: "publish-mismatch", kind: "compiled" }), expectedIdentity: identity("a", 5) });
    expect(failureOf(() => coordinator.publishPrepared({ reservation: mismatch, publish: () => ({ status: "published", observedIdentity: identity("b", 5) }) })).code)
      .toBe("SESSION_NAMESPACE_IDENTITY_MISMATCH");
    expect(coordinator.read("publish-mismatch")).toMatchObject({ state: "quarantined", reasonCode: "DURABLE_IDENTITY_MISMATCH" });

    const reentry = coordinator.prepare({ reservation: coordinator.reserve({ sessionId: "lock-order", kind: "ordinary" }), expectedIdentity: identity("c", 6) });
    expect(coordinator.publishPrepared({
      reservation: reentry,
      publish: () => {
        expect(failureOf(() => coordinator.read("lock-order")).code).toBe("SESSION_NAMESPACE_BUSY");
        return { status: "not-published" };
      },
    })).toMatchObject({ status: "not-published" });
  });

  it("rejects an async publication callback instead of letting it escape the namespace fence", () => {
    const coordinator = new SessionNamespaceCoordinator(root());
    const prepared = coordinator.prepare({ reservation: coordinator.reserve({ sessionId: "async-publication", kind: "ordinary" }), expectedIdentity: identity("d", 7) });
    expect(failureOf(() => coordinator.publishPrepared({
      reservation: prepared,
      publish: (() => Promise.resolve({ status: "published", observedIdentity: identity("d", 7) })) as unknown as () => never,
    })).code).toBe("SESSION_NAMESPACE_STORAGE_FAILED");
    expect(coordinator.read("async-publication")).toMatchObject({ state: "quarantined", reasonCode: "ASYNC_PUBLICATION_CALLBACK" });
  });

  it("holds BEGIN IMMEDIATE across a real subordinate publication so another kind cannot publish the same ID", async () => {
    const dir = root();
    const marker = join(dir, "published-kind.txt");
    const holder = spawnHeldPublisher(dir, "publication-race", "ordinary", marker);
    expect(await holder.next()).toMatchObject({ event: "ready" });
    const contender = await reserveInChild(dir, "publication-race", "compiled");
    expect(contender).toMatchObject({ status: "refused", code: "SESSION_NAMESPACE_BUSY" });
    holder.release();
    expect(await holder.finish()).toMatchObject({ status: "committed", kind: "ordinary" });
    expect(readFileSync(marker, "utf8")).toBe("ordinary");
    expect(new SessionNamespaceCoordinator(dir).read("publication-race")).toMatchObject({ state: "committed", kind: "ordinary" });
  }, 20_000);

  it("reconciles an expired crash reservation to an abandoned tombstone without allowing reuse", () => {
    let now = 1_000;
    const coordinator = new SessionNamespaceCoordinator(root(), { now: () => now });
    coordinator.reserve({ sessionId: "crashed", kind: "ordinary", leaseMs: 10 });
    now += 10;
    expect(coordinator.reconcile()).toEqual({ expiredReservations: 1 });
    expect(coordinator.read("crashed")).toMatchObject({ state: "abandoned", reasonCode: "LEASE_EXPIRED" });
    expect(failureOf(() => coordinator.reserve({ sessionId: "crashed", kind: "compiled" })).code)
      .toBe("SESSION_NAMESPACE_CONFLICT");

    const prepared = coordinator.prepare({
      reservation: coordinator.reserve({ sessionId: "prepared-crash", kind: "compiled", leaseMs: 10 }),
      expectedIdentity: identity("f", 9),
    });
    now += 10;
    expect(coordinator.reconcile()).toEqual({ expiredReservations: 0 });
    expect(coordinator.read("prepared-crash")).toMatchObject({ state: "prepared" });
    expect(coordinator.reconcileObserved({ sessionId: "prepared-crash", kind: "compiled", observedIdentity: prepared.expectedIdentity! }))
      .toMatchObject({ state: "committed", expectedIdentity: identity("f", 9) });
  });

  it("keeps an ID tombstoned after an owner process exits before completing its lease", async () => {
    const dir = root();
    expect(await reserveInChild(dir, "crash-exit", "ordinary", 1)).toMatchObject({ status: "reserved" });
    await Bun.sleep(10);
    const coordinator = new SessionNamespaceCoordinator(dir);
    expect(coordinator.reconcile()).toEqual({ expiredReservations: 1 });
    expect(coordinator.read("crash-exit")).toMatchObject({ state: "abandoned", reasonCode: "LEASE_EXPIRED" });
    expect(failureOf(() => coordinator.reserve({ sessionId: "crash-exit", kind: "compiled" })).code)
      .toBe("SESSION_NAMESPACE_CONFLICT");
  }, 20_000);

  it("fails closed when another process configures the shared root with a different policy", () => {
    const dir = root();
    new SessionNamespaceCoordinator(dir, { domain: "runtime-session-namespace" })
      .reserve({ sessionId: "policy", kind: "ordinary" });
    const mismatch = new SessionNamespaceCoordinator(dir, { domain: "other-session-namespace" });
    expect(failureOf(() => mismatch.read("policy")).code).toBe("SESSION_NAMESPACE_POLICY_MISMATCH");
  });

  it("migrates a legacy namespace only through an explicit exclusive initializer, then fences old versions and epochs", () => {
    const dir = root();
    mkdirSync(dir, { recursive: true });
    const legacy = new Database(join(dir, ".runtime-session-namespace.sqlite"));
    legacy.run("CREATE TABLE session_namespace_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL)");
    legacy.run("INSERT INTO session_namespace_policy (singleton, schema_version, coordinator_domain) VALUES (1, '1.0.0', 'runtime-session-namespace')");
    legacy.close();

    expect(failureOf(() => new SessionNamespaceCoordinator(dir).initialize()).code).toBe("SESSION_NAMESPACE_POLICY_MISMATCH");
    const migrated = new SessionNamespaceCoordinator(dir, { allowLegacyMigration: true });
    migrated.initialize();
    expect(migrated.reserve({ sessionId: "epoch-owned", kind: "ordinary" }).kind).toBe("ordinary");
    expect(failureOf(() => new SessionNamespaceCoordinator(dir, { schemaVersion: "1.0.0" }).initialize()).code)
      .toBe("SESSION_NAMESPACE_POLICY_MISMATCH");
    expect(failureOf(() => new SessionNamespaceCoordinator(dir, { rootEpoch: "runtime-session-required-other" }).initialize()).code)
      .toBe("SESSION_NAMESPACE_POLICY_MISMATCH");
  });

  it("quarantines conflicting legacy-store evidence and keeps the quarantine across restart", () => {
    const dir = root();
    const first = new SessionNamespaceCoordinator(dir);
    expect(first.adoptCommitted({ sessionId: "legacy", kind: "ordinary", observedIdentity: identity("f", 7) }))
      .toMatchObject({ state: "committed", kind: "ordinary", expectedIdentity: identity("f", 7) });
    const restarted = new SessionNamespaceCoordinator(dir);
    expect(restarted.adoptCommitted({ sessionId: "legacy", kind: "ordinary", observedIdentity: identity("f", 7) }))
      .toMatchObject({ state: "committed", kind: "ordinary" });
    expect(restarted.adoptCommitted({ sessionId: "legacy", kind: "compiled", observedIdentity: identity("f", 7) }))
      .toMatchObject({ state: "quarantined", kind: "ordinary", expectedIdentity: identity("f", 7), reasonCode: "OBSERVED_COMMITTED_CONFLICT" });
    expect(new SessionNamespaceCoordinator(dir).read("legacy"))
      .toMatchObject({ state: "quarantined", kind: "ordinary", expectedIdentity: identity("f", 7), reasonCode: "OBSERVED_COMMITTED_CONFLICT" });

    restarted.adoptCommitted({ sessionId: "legacy-same-kind", kind: "ordinary", observedIdentity: identity("b", 8) });
    expect(restarted.reconcileObserved({
      sessionId: "legacy-same-kind", kind: "ordinary", observedIdentity: identity("c", 8),
      observedPredecessorHash: identity("a", 7).hash,
    }))
      .toMatchObject({ state: "quarantined", kind: "ordinary", expectedIdentity: identity("b", 8), reasonCode: "OBSERVED_COMMITTED_CONFLICT" });

    const unowned = restarted.reserve({ sessionId: "partial", kind: "ordinary" });
    expect(restarted.reconcileObserved({ sessionId: "partial", kind: "compiled", reasonCode: "OBSERVED_STORE_CONFLICT" }))
      .toMatchObject({ state: "quarantined", kind: "ordinary", reasonCode: "OBSERVED_STORE_CONFLICT" });
    expect(failureOf(() => restarted.release({ reservation: unowned, reasonCode: "OWNER_RELEASED" })).code)
      .toBe("SESSION_NAMESPACE_CONFLICT");
  });

  it("reports a typed startup busy or conflict, and a later observer persists the cross-kind quarantine", async () => {
    const dir = root();
    const results = await Promise.all([
      reserveInChild(dir, "startup-adopt", "ordinary", undefined, "adopt"),
      reserveInChild(dir, "startup-adopt", "compiled", undefined, "adopt"),
    ]);
    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.find((result) => result.status !== "committed")).toMatchObject({
      status: expect.stringMatching(/^(quarantined|refused)$/),
      ...(results.some((result) => result.status === "refused") ? { code: "SESSION_NAMESPACE_BUSY" } : {}),
    });
    const winner = results.find((result) => result.status === "committed")!;
    const laterKind: RuntimeSessionKind = winner.kind === "ordinary" ? "compiled" : "ordinary";
    expect(new SessionNamespaceCoordinator(dir).adoptCommitted({
      sessionId: "startup-adopt",
      kind: laterKind,
      observedIdentity: identity(),
    }))
      .toMatchObject({ state: "quarantined", kind: expect.stringMatching(/^(ordinary|compiled)$/), reasonCode: expect.stringMatching(/^OBSERVED_(COMMITTED_CONFLICT|IDENTITY_MISMATCH)$/) });
  }, 20_000);

  it("serializes ordinary-vs-ordinary reservations in separate processes", async () => {
    const dir = root();
    const results = await Promise.all([
      reserveInChild(dir, "cross-ordinary", "ordinary"),
      reserveInChild(dir, "cross-ordinary", "ordinary"),
    ]);
    const winners = results.filter((result) => result.status === "reserved");
    // busy_timeout is deliberately zero: simultaneous SQLite lock attempts
    // may fail closed on both sides, but can never grant the ID twice.
    expect(winners.length).toBeLessThanOrEqual(1);
    for (const loser of results.filter((result) => result.status !== "reserved")) {
      expect(loser).toMatchObject({
        status: "refused", code: expect.stringMatching(/^SESSION_NAMESPACE_(BUSY|CONFLICT)$/),
      });
    }
    if (!winners.length) {
      // A caller that receives the typed retryable outcome can make progress
      // once both one-shot contenders have released their SQLite handles.
      expect(await reserveInChild(dir, "cross-ordinary", "ordinary"))
        .toMatchObject({ status: "reserved", kind: "ordinary" });
    }
    const record = new SessionNamespaceCoordinator(dir).read("cross-ordinary");
    if (!record) throw new Error("cross-ordinary namespace reservation was not persisted");
    expect(record).toMatchObject({ kind: "ordinary", state: "reserved" });
    for (const kind of [record.kind, record.kind === "ordinary" ? "compiled" : "ordinary"] as const) {
      expect(await reserveInChild(dir, "cross-ordinary", kind))
        .toMatchObject({ status: "refused", code: "SESSION_NAMESPACE_CONFLICT" });
    }
  }, 20_000);

  it("serializes ordinary-vs-compiled reservations in separate processes", async () => {
    const dir = root();
    const results = await Promise.all([
      reserveInChild(dir, "cross-kind", "ordinary"),
      reserveInChild(dir, "cross-kind", "compiled"),
    ]);
    const winners = results.filter((result) => result.status === "reserved");
    expect(winners.length).toBeLessThanOrEqual(1);
    for (const loser of results.filter((result) => result.status !== "reserved")) {
      expect(loser).toMatchObject({
        status: "refused", code: expect.stringMatching(/^SESSION_NAMESPACE_(BUSY|CONFLICT)$/),
      });
    }
    if (!winners.length) {
      expect(await reserveInChild(dir, "cross-kind", "ordinary"))
        .toMatchObject({ status: "reserved", kind: "ordinary" });
    }
    const record = new SessionNamespaceCoordinator(dir).read("cross-kind");
    if (!record) throw new Error("cross-kind namespace reservation was not persisted");
    const reservedKind = record.kind;
    expect(record).toMatchObject({ state: "reserved" });
    expect(["ordinary", "compiled"]).toContain(reservedKind);
    for (const kind of [reservedKind, reservedKind === "ordinary" ? "compiled" : "ordinary"] as const) {
      expect(await reserveInChild(dir, "cross-kind", kind))
        .toMatchObject({ status: "refused", code: "SESSION_NAMESPACE_CONFLICT" });
    }
  }, 20_000);
});
