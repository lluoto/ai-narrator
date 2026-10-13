import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, compiledMechanicsAction } from "../api/game-session";
import { CompiledSessionSnapshotPersistenceError, CompiledSessionSnapshotStore as CompiledSessionSnapshotStoreImplementation, compiledSessionSnapshotNodeFileOps, type CompiledSessionSnapshot, type CompiledSessionSnapshotStoreOptions } from "../api/compiled-session-snapshot";
import { CompiledSessionSnapshotCoordinator, SnapshotCoordinatorFailure } from "../api/compiled-session-snapshot-coordinator";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { handleCompiledModuleHttpRequest } from "../api/compiled-module-http";
import { handleRequest } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import type { SessionNamespacePublicationGate } from "../api/session-namespace-publication";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const child = join(import.meta.dir, "compiled-session-snapshot-process-child.ts");
const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const keeperAuthenticator = () => ({ status: "authenticated" as const, principal: { id: "keeper:snapshot-process", role: "keeper" as const } });
const roots = new Set<string>();

/** The direct writers in this protocol suite are standalone fixtures. */
class CompiledSessionSnapshotStore extends CompiledSessionSnapshotStoreImplementation {
  constructor(options: CompiledSessionSnapshotStoreOptions = {}) {
    super({ ...options, allowUncoordinatedTestWrites: true });
  }
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "compiled-snapshot-process-"));
  roots.add(value);
  return value;
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000); });
  return Promise.race([promise, expiry]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
}

type ChildResult = { status: string; code?: string; value?: { snapshotHash?: string; generation?: number } };
interface ChildEvent { event: "ready" | "result"; result?: ChildResult; }
interface Child {
  next(): Promise<ChildEvent>;
  release(): void;
  kill(): Promise<void>;
  finish(): Promise<ChildResult>;
}

function spawnSnapshotWriter(rootPath: string, snapshotFile: string, quota?: { maxEntries: number; maxBytes: number }): Child {
  const childProcess = Bun.spawn([process.execPath, child], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      SNAPSHOT_PROCESS_ROOT: rootPath,
      SNAPSHOT_PROCESS_FILE: snapshotFile,
      ...(quota ? { SNAPSHOT_PROCESS_MAX_ENTRIES: String(quota.maxEntries), SNAPSHOT_PROCESS_MAX_BYTES: String(quota.maxBytes) } : {}),
    },
  });
  const events: ChildEvent[] = [];
  let wake: (() => void) | undefined;
  let stdout = "", stderr = "", line = "";
  let finalResult: ChildResult | undefined;
  const drain = async (stream: ReadableStream<Uint8Array>, capture: (text: string) => void, parse: boolean) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true }); capture(text);
      if (!parse) continue;
      line += text;
      for (;;) {
        const end = line.indexOf("\n");
        if (end < 0) break;
        const value = line.slice(0, end); line = line.slice(end + 1);
        try {
          const event = JSON.parse(value) as ChildEvent;
          if (event.event === "result") finalResult = event.result;
          events.push(event); wake?.(); wake = undefined;
        } catch { /* finish reports raw output */ }
      }
    }
  };
  const stdoutDrain = drain(childProcess.stdout, (text) => { stdout += text; }, true);
  const stderrDrain = drain(childProcess.stderr, (text) => { stderr += text; }, false);
  return {
    async next() {
      while (!events.length) await new Promise<void>((resolve) => { wake = resolve; });
      return events.shift()!;
    },
    release() {
      const stdin = childProcess.stdin;
      if (!stdin || typeof stdin === "number") throw new Error("snapshot child stdin is unavailable");
      stdin.write("x"); stdin.end();
    },
    async kill() {
      childProcess.kill();
      await within(childProcess.exited, "killed snapshot child exit");
    },
    async finish() {
      const code = await within(childProcess.exited, "snapshot child exit");
      await within(Promise.all([stdoutDrain, stderrDrain]), "snapshot child output drain");
      const result = finalResult;
      if (!result) throw new Error(`snapshot child omitted result (exit ${code}): ${stdout} ${stderr}`);
      return result;
    },
  };
}

async function competingSuccessors(dir: string, sessionId = "snapshotcas"): Promise<{ store: CompiledSessionSnapshotStore; initial: CompiledSessionSnapshot; a: CompiledSessionSnapshot; b: CompiledSessionSnapshot }> {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const storedBundle = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
  if (storedBundle.status !== "ok") throw new Error(storedBundle.message);
  const bundle = catalog.loadBundle(storedBundle.value.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const store = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots") });
  const initialHost = createCompiledDurableTestHost();
  const initialSession = new GameSession(
    sessionId, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", initialHost.runtimeDependencies,
  );
  if (initialSession.loadDurableCompiledModule(bundle.value).status !== "loaded") throw new Error("fixture durable module did not load");
  const initial = initialHost.snapshot(initialSession);
  if (store.save(initial).status !== "ok") throw new Error("initial snapshot did not save");
  initialHost.acknowledge(initialSession, initial);
  const action = compiledMechanicsAction((fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id);
  const successor = (actionId: string): CompiledSessionSnapshot => {
    const host = createCompiledDurableTestHost();
    const session = new GameSession(
      initial.sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, `careers-${actionId}`) }, undefined, "preferred", host.runtimeDependencies,
    );
    const restored = session.restoreCompiledSession(initial, bundle.value);
    if (restored.status !== "loaded") throw new Error(restored.message);
    const committed = host.commit(session, action, actionId, 0, () => undefined);
    if (committed.status !== "committed" || !committed.snapshot) throw new Error("successor snapshot did not prepare");
    return committed.snapshot;
  };
  return { store, initial, a: successor("process-a"), b: successor("process-b") };
}

describe("CompiledSessionSnapshotStore cross-process CAS", () => {
  it("rejects a default raw compiled write before it creates its snapshot root", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog-default-fence") });
    const storedBundle = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
    if (storedBundle.status !== "ok") throw new Error(storedBundle.message);
    const bundle = catalog.loadBundle(storedBundle.value.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    const host = createCompiledDurableTestHost();
    const session = new GameSession(
      "default-compiled-fence", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers-default-fence") }, undefined, "preferred", host.runtimeDependencies,
    );
    try {
      if (session.loadDurableCompiledModule(bundle.value).status !== "loaded") throw new Error("fixture durable module did not load");
      const snapshotRoot = join(dir, "snapshots-default-fence");
      const productionStore = new CompiledSessionSnapshotStoreImplementation({ root: snapshotRoot });
      expect(productionStore.save(host.snapshot(session))).toMatchObject({ status: "refused", code: "SNAPSHOT_NAMESPACE_FENCED" });
      expect(existsSync(snapshotRoot)).toBe(false);
    } finally { session.close(); }
  }, 20_000);

  it("requires a coordinator-issued one-shot namespace permit for direct, forged, and replayed compiled publication", async () => {
    const dir = root();
    const { store, initial, a } = await competingSuccessors(dir, "namespace-compiled-permit");
    const namespace = new SessionNamespaceCoordinator(join(dir, "namespace"));
    const gate: SessionNamespacePublicationGate = {
      required: true,
      consume: (permit, expected) => namespace.consumePublicationPermit(permit, expected),
    };
    const gated = new CompiledSessionSnapshotStore({ root: store.root, namespacePublicationGate: gate });
    const initialIdentity = { hash: initial.snapshotHash.replace("sha256:", ""), generation: initial.generation, format: "compiled-session-snapshot-v1" };
    const nextIdentity = { hash: a.snapshotHash.replace("sha256:", ""), generation: a.generation, format: "compiled-session-snapshot-v1" };
    namespace.adoptCommitted({ sessionId: initial.sessionId, kind: "compiled", observedIdentity: initialIdentity });
    expect(gated.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_NAMESPACE_FENCED" });
    const forged = { token: "forged", kind: "compiled" as const, sessionId: initial.sessionId, fencingToken: 1, previousIdentity: initialIdentity, nextIdentity };
    expect(gated.save(a, { permit: forged })).toMatchObject({ status: "refused", code: "SNAPSHOT_NAMESPACE_FENCED" });
    let issued: import("../api/session-namespace-coordinator").SessionNamespacePublicationPermit | undefined;
    expect(namespace.publishCommitted({
      sessionId: initial.sessionId, kind: "compiled", previousIdentity: initialIdentity, nextIdentity,
      publish: (permit) => {
        issued = permit;
        const saved = gated.save(a, { permit });
        expect(saved).toMatchObject({ status: "ok", value: { snapshotHash: a.snapshotHash, generation: 1 } });
        return { status: "published", observedIdentity: nextIdentity };
      },
    })).toMatchObject({ state: "committed", expectedIdentity: nextIdentity });
    expect(gated.save(a, { permit: issued! })).toMatchObject({ status: "refused", code: "SNAPSHOT_NAMESPACE_FENCED" });
  }, 20_000);

  it("allows at most one distinct successor from one durable predecessor", async () => {
    const dir = root();
    const { store, a, b } = await competingSuccessors(dir);
    const aFile = join(dir, "a.json"), bFile = join(dir, "b.json");
    writeFileSync(aFile, JSON.stringify(a)); writeFileSync(bFile, JSON.stringify(b));
    const first = spawnSnapshotWriter(store.root, aFile);
    expect(await within(first.next(), "first successor after predecessor check")).toMatchObject({ event: "ready" });
    const second = spawnSnapshotWriter(store.root, bFile);
    const secondGate = await within(second.next(), "second successor gate");
    first.release();
    if (secondGate.event === "ready") second.release();
    const [aResult, bResult] = await Promise.all([first.finish(), second.finish()]);
    const results = [aResult, bResult];
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(results.find((result) => result.status !== "ok")).toMatchObject({ status: "refused", code: expect.stringMatching(/^SNAPSHOT_(BUSY|CONFLICT)$/) });
    const winner = a.snapshotHash === results.find((result) => result.status === "ok")?.value?.snapshotHash ? a : b;
    const loser = winner === a ? b : a;
    // A completed writer can replay its exact immutable value, whereas the
    // other successor from the same predecessor can never become current.
    expect(new CompiledSessionSnapshotStore({ root: store.root }).save(winner)).toMatchObject({ status: "ok", value: { snapshotHash: winner.snapshotHash, generation: 1 } });
    expect(new CompiledSessionSnapshotStore({ root: store.root }).save(loser)).toMatchObject({ status: "refused", code: "SNAPSHOT_CONFLICT" });
    const durable = new CompiledSessionSnapshotStore({ root: store.root }).read("snapshotcas");
    expect(durable).toMatchObject({ status: "ok", value: expect.objectContaining({ generation: 1, snapshotHash: winner.snapshotHash }) });
  }, 20_000);

  it("makes concurrent exact-snapshot replay retryably busy, then returns the same durable header", async () => {
    const dir = root();
    const { store, a } = await competingSuccessors(dir);
    expect(store.save(a)).toMatchObject({ status: "ok", value: { snapshotHash: a.snapshotHash, generation: 1 } });
    const replayFile = join(dir, "same-successor.json");
    writeFileSync(replayFile, JSON.stringify(a));
    const first = spawnSnapshotWriter(store.root, replayFile);
    const second = spawnSnapshotWriter(store.root, replayFile);
    const [firstResult, secondResult] = await Promise.all([first.finish(), second.finish()]);
    for (const result of [firstResult, secondResult]) {
      expect(result.status === "ok" || result.status === "refused" && result.code === "SNAPSHOT_BUSY").toBe(true);
    }
    // busy_timeout remains zero: a contended replay may be told to retry, but
    // after the holder releases it is exactly idempotent and yields the same
    // durable header rather than a predecessor conflict.
    expect(new CompiledSessionSnapshotStore({ root: store.root }).save(a)).toMatchObject({ status: "ok", value: { snapshotHash: a.snapshotHash, generation: 1 } });
  }, 20_000);

  it("releases a held coordinator lock when its writer process is terminated", async () => {
    const dir = root();
    const { store, a } = await competingSuccessors(dir);
    const snapshotFile = join(dir, "terminated-writer.json");
    writeFileSync(snapshotFile, JSON.stringify(a));

    const holder = spawnSnapshotWriter(store.root, snapshotFile);
    expect(await within(holder.next(), "held writer coordinator gate")).toMatchObject({ event: "ready" });
    await holder.kill();

    const retry = spawnSnapshotWriter(store.root, snapshotFile);
    expect(await within(retry.next(), "replacement writer coordinator gate")).toMatchObject({ event: "ready" });
    retry.release();
    expect(await retry.finish()).toMatchObject({ status: "ok", value: { snapshotHash: a.snapshotHash, generation: 1 } });
    expect(new CompiledSessionSnapshotStore({ root: store.root }).read("snapshotcas")).toMatchObject({
      status: "ok", value: { generation: 1, snapshotHash: a.snapshotHash },
    });
  }, 20_000);

  it("does not acknowledge an exact replay when its current header loses the immutable body", async () => {
    const dir = root();
    const { store, a } = await competingSuccessors(dir);
    expect(store.save(a)).toMatchObject({ status: "ok" });
    const body = join(store.root, `snapshotcas.${a.snapshotHash}.json`);
    unlinkSync(body);
    const replay = new CompiledSessionSnapshotStore({ root: store.root });
    expect(replay.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_CORRUPT" });
    expect(() => unlinkSync(body)).toThrow();
  }, 20_000);

  it("reclaims the superseded immutable body only after the successor durable reload", async () => {
    const dir = root();
    const { store, a } = await competingSuccessors(dir);
    const predecessorBodies = readdirSync(store.root).filter((name) => /^snapshotcas\.[a-f0-9]{64}\.json$/.test(name));
    expect(predecessorBodies).toHaveLength(1);
    expect(store.save(a)).toMatchObject({ status: "ok", value: { generation: 1, snapshotHash: a.snapshotHash } });
    const durable = new CompiledSessionSnapshotStore({ root: store.root }).read("snapshotcas");
    expect(durable).toMatchObject({ status: "ok", value: { generation: 1, snapshotHash: a.snapshotHash } });
    expect(readdirSync(store.root).filter((name) => /^snapshotcas\.[a-f0-9]{64}\.json$/.test(name)))
      .toEqual([`snapshotcas.${a.snapshotHash}.json`]);
  }, 20_000);

  it("treats a zero admission cap as no snapshot body/header publication after coordinator bootstrap", async () => {
    const dir = root();
    const { initial } = await competingSuccessors(dir);
    const g0 = initial;
    const limited = new CompiledSessionSnapshotStore({ root: join(dir, "quota-zero"), maxBytes: 0, maxEntries: 0 } as any);
    expect(limited.save(g0)).toMatchObject({ status: "refused", code: "SNAPSHOT_QUOTA_EXCEEDED" });
    expect(limited.readHeader(g0.sessionId)).toMatchObject({ status: "refused", code: "SNAPSHOT_NOT_FOUND" });
    const names = readdirSync(join(dir, "quota-zero"));
    expect(names).not.toContain(`${g0.sessionId}.header.json`);
    expect(names).not.toContain(`${g0.sessionId}.${g0.snapshotHash}.json`);
  }, 20_000);

  it("fails closed when the persistent snapshot quota policy differs across processes", async () => {
    const dir = root();
    const { initial } = await competingSuccessors(dir);
    const g0 = initial;
    const rootPath = join(dir, "quota-policy");
    const first = new CompiledSessionSnapshotStore({ root: rootPath, maxEntries: 64, maxBytes: 16 * 1024 * 1024 } as any);
    expect(first.save(g0)).toMatchObject({ status: "ok" });
    const mismatched = new CompiledSessionSnapshotStore({ root: rootPath, maxEntries: 65, maxBytes: 16 * 1024 * 1024 } as any);
    expect(mismatched.save(g0)).toMatchObject({ status: "refused", code: "SNAPSHOT_POLICY_MISMATCH" });
  }, 20_000);

  it("admits exactly the measured peak entry and byte footprint, then rejects one byte less before writing a header", async () => {
    const dir = root();
    const { initial } = await competingSuccessors(dir);
    const templateRoot = join(dir, "quota-template");
    const template = new CompiledSessionSnapshotStore({ root: templateRoot, maxEntries: 64, maxBytes: 64 * 1024 * 1024 });
    expect(template.save(initial)).toMatchObject({ status: "ok" });
    const bodyName = `${initial.sessionId}.${initial.snapshotHash}.json`;
    const headerName = `${initial.sessionId}.header.json`;
    const entries = readdirSync(templateRoot);
    const bodyBytes = statSync(join(templateRoot, bodyName)).size;
    const headerBytes = statSync(join(templateRoot, headerName)).size;
    const overheadBytes = entries.filter((name) => name !== bodyName && name !== headerName)
      .reduce((total, name) => total + statSync(join(templateRoot, name)).size, 0);
    const peakBytes = overheadBytes + Math.max(bodyBytes * 2, bodyBytes + headerBytes);
    const peakEntries = entries.length;
    const exact = new CompiledSessionSnapshotStore({ root: join(dir, "quota-exact"), maxEntries: peakEntries, maxBytes: peakBytes });
    expect(exact.save(initial)).toMatchObject({ status: "ok" });
    const under = new CompiledSessionSnapshotStore({ root: join(dir, "quota-under"), maxEntries: peakEntries, maxBytes: peakBytes - 1 });
    expect(under.save(initial)).toMatchObject({ status: "refused", code: "SNAPSHOT_QUOTA_EXCEEDED" });
    expect(under.readHeader(initial.sessionId)).toMatchObject({ status: "refused", code: "SNAPSHOT_NOT_FOUND" });
  }, 20_000);

  it("serializes true cross-process quota admission so only one generation-zero root can fit", async () => {
    const dir = root();
    const firstSource = await competingSuccessors(join(dir, "source-a"), "quota-a");
    const secondSource = await competingSuccessors(join(dir, "source-b"), "quota-b");
    const target = join(dir, "quota-target");
    const firstFile = join(dir, "quota-a.json"), secondFile = join(dir, "quota-b.json");
    writeFileSync(firstFile, JSON.stringify(firstSource.initial));
    writeFileSync(secondFile, JSON.stringify(secondSource.initial));
    const quota = { maxEntries: 4, maxBytes: 16 * 1024 * 1024 };
    const first = spawnSnapshotWriter(target, firstFile, quota);
    expect(await within(first.next(), "first quota writer gate")).toMatchObject({ event: "ready" });
    const second = spawnSnapshotWriter(target, secondFile, quota);
    first.release();
    const secondEvent = await within(second.next(), "second quota writer result");
    if (secondEvent.event === "ready") second.release();
    const [firstResult, secondResult] = await Promise.all([first.finish(), second.finish()]);
    expect([firstResult, secondResult].filter((result) => result.status === "ok")).toHaveLength(1);
    expect([firstResult, secondResult].find((result) => result.status !== "ok")).toMatchObject({
      status: "refused", code: expect.stringMatching(/^SNAPSHOT_(BUSY|QUOTA_EXCEEDED)$/),
    });
    expect(new CompiledSessionSnapshotStore({ root: target, ...quota }).save(secondSource.initial))
      .toMatchObject({ status: "refused", code: "SNAPSHOT_QUOTA_EXCEEDED" });
  }, 30_000);

  it("cleans only a fully verified body orphan from a body-before-header interruption", async () => {
    const dir = root();
    const { initial } = await competingSuccessors(dir);
    const snapshotRoot = join(dir, "crash-orphan");
    const interrupted = new CompiledSessionSnapshotStore({
      root: snapshotRoot,
      fileOps: { ...compiledSessionSnapshotNodeFileOps, writeReplace: () => { throw new Error("interrupt before current header"); } },
    });
    expect(interrupted.save(initial)).toMatchObject({ status: "indeterminate", code: "SNAPSHOT_INDETERMINATE" });
    const bodyName = `${initial.sessionId}.${initial.snapshotHash}.json`;
    expect(readdirSync(snapshotRoot)).toContain(bodyName);
    expect(interrupted.readHeader(initial.sessionId)).toMatchObject({ status: "refused", code: "SNAPSHOT_NOT_FOUND" });
    const retry = new CompiledSessionSnapshotStore({ root: snapshotRoot });
    expect(retry.save(initial)).toMatchObject({ status: "ok", value: { snapshotHash: initial.snapshotHash, generation: 0 } });
    expect(readdirSync(snapshotRoot).filter((name) => /^snapshotcas\.[a-f0-9]{64}\.json$/.test(name))).toEqual([bodyName]);
  }, 20_000);

  it("counts unknown regular files without deleting them, and never deletes a current body on quota refusal", async () => {
    const dir = root();
    const { initial, a } = await competingSuccessors(dir);
    const snapshotRoot = join(dir, "unknown-quota");
    const quota = { maxEntries: 4, maxBytes: 16 * 1024 * 1024 };
    const store = new CompiledSessionSnapshotStore({ root: snapshotRoot, ...quota });
    expect(store.save(initial)).toMatchObject({ status: "ok" });
    writeFileSync(join(snapshotRoot, "unrecognized-retain.bin"), "accounted but never removed");
    const currentBody = join(snapshotRoot, `${initial.sessionId}.${initial.snapshotHash}.json`);
    expect(store.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_QUOTA_EXCEEDED" });
    expect(readFileSync(join(snapshotRoot, "unrecognized-retain.bin"), "utf8")).toBe("accounted but never removed");
    expect(readFileSync(currentBody, "utf8")).toContain(initial.snapshotHash);
    expect(new CompiledSessionSnapshotStore({ root: snapshotRoot, ...quota }).read(initial.sessionId))
      .toMatchObject({ status: "ok", value: { generation: 0, snapshotHash: initial.snapshotHash } });
  }, 20_000);

  it("measures root usage only after the publication lock is held", async () => {
    const dir = root();
    const { initial, a } = await competingSuccessors(dir);
    const snapshotRoot = join(dir, "locked-usage");
    const quota = { maxEntries: 5, maxBytes: 16 * 1024 * 1024 };
    const seed = new CompiledSessionSnapshotStore({ root: snapshotRoot, ...quota });
    expect(seed.save(initial)).toMatchObject({ status: "ok" });
    let injected = false;
    const contender = new CompiledSessionSnapshotStore({
      root: snapshotRoot,
      ...quota,
      coordinatorFactory: (rootPath) => {
        const coordinator = new CompiledSessionSnapshotCoordinator(rootPath);
        return {
          initializePolicy: (policy) => coordinator.initializePolicy(policy),
          beginPublication() {
            coordinator.beginPublication();
            if (!injected) {
              injected = true;
              writeFileSync(join(rootPath, "appeared-under-lock.bin"), "count me");
            }
          },
          finishPublication: () => coordinator.finishPublication(),
        };
      },
    });
    expect(contender.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_QUOTA_EXCEEDED" });
    expect(seed.read(initial.sessionId)).toMatchObject({ status: "ok", value: { generation: 0 } });
  }, 20_000);

  it("fails closed with zero GC deletion for malformed headers, missing current bodies, unsafe bodies, and an unsafe root", async () => {
    const dir = root();
    const { initial, a } = await competingSuccessors(dir);
    const malformedRoot = join(dir, "malformed-header");
    const malformed = new CompiledSessionSnapshotStore({ root: malformedRoot });
    expect(malformed.save(initial)).toMatchObject({ status: "ok" });
    const retainedBody = join(malformedRoot, `${initial.sessionId}.${initial.snapshotHash}.json`);
    writeFileSync(join(malformedRoot, `${initial.sessionId}.header.json`), "{");
    expect(malformed.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_STORAGE_FAILED" });
    expect(readFileSync(retainedBody, "utf8")).toContain(initial.snapshotHash);

    const missingRoot = join(dir, "missing-current");
    const missing = new CompiledSessionSnapshotStore({ root: missingRoot });
    expect(missing.save(initial)).toMatchObject({ status: "ok" });
    unlinkSync(join(missingRoot, `${initial.sessionId}.${initial.snapshotHash}.json`));
    expect(missing.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_CORRUPT" });
    expect(readFileSync(join(missingRoot, `${initial.sessionId}.header.json`), "utf8")).toContain(initial.snapshotHash);

    const unsafeRoot = join(dir, "unsafe-body");
    const safe = new CompiledSessionSnapshotStore({ root: unsafeRoot });
    expect(safe.save(initial)).toMatchObject({ status: "ok" });
    const unsafeBody = join(unsafeRoot, `${initial.sessionId}.${initial.snapshotHash}.json`);
    const unsafe = new CompiledSessionSnapshotStore({
      root: unsafeRoot,
      fileOps: { ...compiledSessionSnapshotNodeFileOps, kind: (path) => path === unsafeBody ? "unsafe" : compiledSessionSnapshotNodeFileOps.kind(path) },
    });
    expect(unsafe.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_STORAGE_FAILED" });
    expect(readFileSync(unsafeBody, "utf8")).toContain(initial.snapshotHash);

    const rootUnsafe = new CompiledSessionSnapshotStore({
      root: unsafeRoot,
      fileOps: { ...compiledSessionSnapshotNodeFileOps, kind: (path) => path === unsafeRoot ? "unsafe" : compiledSessionSnapshotNodeFileOps.kind(path) },
    });
    expect(rootUnsafe.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_STORAGE_FAILED" });
    expect(readFileSync(unsafeBody, "utf8")).toContain(initial.snapshotHash);
  }, 20_000);

  it("never follows or unlinks a real symlink leaf through node snapshot file operations when the OS permits leaf links", async () => {
    const dir = root();
    const target = join(dir, "target.json");
    const link = join(dir, "linked.json");
    writeFileSync(target, "durable-target");
    try { symlinkSync(target, link, "file"); }
    catch (error) {
      // Windows installations without Developer Mode/admin symlink privilege
      // may still permit a junction probe. It verifies the same initial lstat
      // rejection path without pretending a denied leaf link was exercised.
      expect((error as { code?: string }).code).toBe("EPERM");
      const targetDirectory = join(dir, "target-directory");
      const junction = join(dir, "linked-directory");
      mkdirSync(targetDirectory);
      try {
        symlinkSync(targetDirectory, junction, "junction");
      } catch (junctionError) {
        // This runner grants neither file-link nor junction creation. There is
        // no real OS-link coverage in this branch; use the production seam to
        // prove an unsafe leaf is rejected before read (and therefore open) or
        // remove (and therefore unlink) can touch it.
        expect((junctionError as { code?: string }).code).toBe("EPERM");
        const { store, initial, a } = await competingSuccessors(dir);
        const unsafeBody = join(store.root, `${initial.sessionId}.${initial.snapshotHash}.json`);
        let unsafeReads = 0;
        let unsafeRemovals = 0;
        const guarded = new CompiledSessionSnapshotStore({
          root: store.root,
          fileOps: {
            ...compiledSessionSnapshotNodeFileOps,
            kind: (path) => path === unsafeBody ? "unsafe" : compiledSessionSnapshotNodeFileOps.kind(path),
            read(path, maxBytes) {
              if (path === unsafeBody) unsafeReads++;
              return compiledSessionSnapshotNodeFileOps.read(path, maxBytes);
            },
            remove(path) {
              if (path === unsafeBody) unsafeRemovals++;
              return compiledSessionSnapshotNodeFileOps.remove(path);
            },
          },
          coordinatorFactory: () => ({
            initializePolicy: () => undefined,
            beginPublication: () => undefined,
            finishPublication: () => ({}),
          }),
        });
        expect(guarded.read(initial.sessionId)).toMatchObject({ status: "refused", code: "SNAPSHOT_STORAGE_FAILED" });
        expect(guarded.save(a)).toMatchObject({ status: "refused", code: "SNAPSHOT_STORAGE_FAILED" });
        expect(unsafeReads).toBe(0);
        expect(unsafeRemovals).toBe(0);
        return;
      }
      expect(compiledSessionSnapshotNodeFileOps.kind(junction)).toBe("unsafe");
      return;
    }
    expect(() => compiledSessionSnapshotNodeFileOps.read(link, 1024)).toThrow("regular non-link");
    expect(() => compiledSessionSnapshotNodeFileOps.remove(link)).toThrow("regular non-link");
    expect(readFileSync(target, "utf8")).toBe("durable-target");
    expect(readFileSync(link, "utf8")).toBe("durable-target");
  });

  it("classifies a successor cleanup directory-sync failure as indeterminate after its durable header reload", async () => {
    const dir = root();
    const { store, a } = await competingSuccessors(dir);
    let syncCalls = 0;
    const cleanupFailure = new CompiledSessionSnapshotStore({
      root: store.root,
      fileOps: {
        ...compiledSessionSnapshotNodeFileOps,
        syncDirectory(path) {
          syncCalls++;
          if (syncCalls === 3) throw new Error("post-commit cleanup directory sync failed");
          compiledSessionSnapshotNodeFileOps.syncDirectory?.(path);
        },
      },
    });
    expect(cleanupFailure.save(a)).toMatchObject({ status: "indeterminate", code: "SNAPSHOT_INDETERMINATE" });
    expect(new CompiledSessionSnapshotStore({ root: store.root }).read("snapshotcas"))
      .toMatchObject({ status: "ok", value: { generation: 1, snapshotHash: a.snapshotHash } });
  }, 20_000);

  it("returns safe authoritative generations at the real HTTP action boundary", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const healthy = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots") });
    const storage = { careerRoot: join(dir, "careers") };
    const created = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, healthy, storage, {}, {}, keeperAuthenticator);
    expect(created.status).toBe(201);
    const creation = await created.json() as { sessionId: string; generation: number };
    const input = compiledMechanicsAction((fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id);
    const busy = new CompiledSessionSnapshotStore({
      root: healthy.root,
      coordinatorFactory: () => ({
        initializePolicy: () => undefined,
        beginPublication: () => { throw new SnapshotCoordinatorFailure("SNAPSHOT_BUSY", "forced busy"); },
        finishPublication: () => ({}),
      }),
    });
    const unavailable = await handleRequest(new Request(`http://test/api/sessions/${creation.sessionId}/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, pcId: "p1", actionId: "busy-generation", expectedGeneration: 0 }),
    }), catalog, busy, storage, {}, {}, keeperAuthenticator);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("Retry-After")).toBe("1");
    expect(await unavailable.json()).toEqual(expect.objectContaining({ code: "compiled_persistence_busy", generation: 0 }));

    // Advance the durable header through a different store while the HTTP
    // registry intentionally still holds the generation-zero object. This is
    // the real stale-writer conflict, not just expectedGeneration validation.
    const raw = healthy.read(creation.sessionId);
    if (raw.status !== "ok") throw new Error(raw.message);
    const bundle = catalog.loadBundle(saved.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    const externalHost = createCompiledDurableTestHost();
    const external = new GameSession(
      creation.sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, undefined, "preferred", externalHost.runtimeDependencies,
    );
    if (external.restoreCompiledSession(raw.value, bundle.value).status !== "loaded") throw new Error("external winner could not restore");
    const winner = externalHost.commit(external, input, "external-winner", 0, (snapshot) => {
      const stored = new CompiledSessionSnapshotStore({ root: healthy.root }).save(snapshot);
      if (stored.status !== "ok") throw new Error(stored.message);
    });
    if (winner.status !== "committed") throw new Error("external winner did not persist");
    const conflict = await handleRequest(new Request(`http://test/api/sessions/${creation.sessionId}/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, pcId: "p1", actionId: "stale-durable-writer", expectedGeneration: 0 }),
    }), catalog, healthy, storage, {}, {}, keeperAuthenticator);
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json() as Record<string, unknown>;
    expect(conflictBody).toEqual(expect.objectContaining({ code: "compiled_generation_conflict", generation: 1 }));
    expect(JSON.stringify(conflictBody)).not.toContain(winner.snapshot?.snapshotHash ?? "not-a-hash");
    // The duplicate can succeed only if conflict recovery replaced the stale
    // registry object with the durable g1 winner and its idempotency ledger.
    const duplicate = await handleRequest(new Request(`http://test/api/sessions/${creation.sessionId}/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, pcId: "p1", actionId: "external-winner", expectedGeneration: 0 }),
    }), catalog, healthy, storage, {}, {}, keeperAuthenticator);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(expect.objectContaining({ generation: 1 }));
  }, 20_000);

  it("returns retryable typed 503 when the real compiled-session creation route is busy", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const busy = new CompiledSessionSnapshotStore({
      root: join(dir, "snapshots"),
      coordinatorFactory: () => ({
        initializePolicy: () => undefined,
        beginPublication: () => { throw new SnapshotCoordinatorFailure("SNAPSHOT_BUSY", "forced busy"); },
        finishPublication: () => ({}),
      }),
    });
    const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, busy, { careerRoot: join(dir, "careers") }, {}, {}, keeperAuthenticator);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "SNAPSHOT_BUSY" }) }));
  }, 20_000);

  it("maps a typed snapshot quota refusal to 507 at the compiled action boundary without storage detail", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const healthy = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots") });
    const storage = { careerRoot: join(dir, "careers") };
    const created = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, healthy, storage, {}, {}, keeperAuthenticator);
    const creation = await created.json() as { sessionId: string };
    const input = compiledMechanicsAction((fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id);
    const limited = new CompiledSessionSnapshotStore({
      root: healthy.root,
      coordinatorFactory: () => ({
        initializePolicy: () => undefined,
        beginPublication: () => { throw new SnapshotCoordinatorFailure("SNAPSHOT_QUOTA_EXCEEDED", "C:/private/root/full"); },
        finishPublication: () => ({}),
      }),
    });
    const response = await handleRequest(new Request(`http://test/api/sessions/${creation.sessionId}/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, pcId: "p1", actionId: "quota-action", expectedGeneration: 0 }),
    }), catalog, limited, storage, {}, {}, keeperAuthenticator);
    expect(response.status).toBe(507);
    expect(response.headers.get("Retry-After")).toBeNull();
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual({ code: "compiled_persistence_quota", generation: 0, message: "compiled snapshot capacity is unavailable" });
    expect(JSON.stringify(payload)).not.toContain("private");
  }, 20_000);

  it("recovers an indeterminate create only through the exact durable snapshot, never a same-owner registry impostor", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const bundle = catalog.loadBundle(saved.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    const storage = { careerRoot: join(dir, "careers") };
    const registry = new Map<string, GameSession>();
    const snapshots = new CompiledSessionSnapshotStore({
      root: join(dir, "snapshots"),
      coordinatorFactory: () => ({
        initializePolicy: () => undefined,
        beginPublication: () => undefined,
        finishPublication: () => ({ closeFailure: new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "force post-publication ambiguity") }),
      }),
    });
    const save = snapshots.save.bind(snapshots);
    let impostor: GameSession | undefined;
    snapshots.save = (snapshot: unknown) => {
      const persisted = save(snapshot);
      if (persisted.status === "indeterminate") {
        const attempted = snapshot as CompiledSessionSnapshot;
        const impostorHost = createCompiledDurableTestHost();
        impostor = new GameSession(
          attempted.sessionId, "cosmic-horror", CONFIG, "investigator", "Mallory", undefined, storage, undefined, "preferred", impostorHost.runtimeDependencies,
        );
        if (impostor.loadDurableCompiledModule(bundle.value, attempted.access).status !== "loaded") throw new Error("impostor fixture could not load");
        // Same locator and owner binding, but a different in-memory state
        // from the Ada body just published durably.
        registry.set(attempted.sessionId, impostor);
      }
      return persisted;
    };
    const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, snapshots, storage, {}, {}, keeperAuthenticator, undefined, undefined, undefined, {}, { registry });
    expect(response.status).toBe(201);
    const body = await response.json() as { sessionId: string; character: { name: string } };
    expect(body.character.name).toBe("Ada");
    const durable = snapshots.read(body.sessionId);
    expect(durable).toMatchObject({ status: "ok", value: { character: { sheet: expect.objectContaining({ name: "Ada" }) } } });
    expect(impostor).toBeDefined();
    expect(registry.get(body.sessionId)).not.toBe(impostor);
    expect(registry.get(body.sessionId)?.getCharacterSummary().name).toBe("Ada");
  }, 20_000);

  it("fails closed when an indeterminate create's durable header has advanced beyond its attempted snapshot", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const bundle = catalog.loadBundle(saved.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    const input = compiledMechanicsAction((fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id);
    const storage = { careerRoot: join(dir, "careers") };
    const snapshotRoot = join(dir, "snapshots");
    const authoritative = new CompiledSessionSnapshotStore({ root: snapshotRoot });
    const indeterminate = new CompiledSessionSnapshotStore({
      root: snapshotRoot,
      coordinatorFactory: () => ({
        initializePolicy: () => undefined,
        beginPublication: () => undefined,
        finishPublication: () => ({ closeFailure: new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "force post-publication ambiguity") }),
      }),
    });
    const save = indeterminate.save.bind(indeterminate);
    indeterminate.save = (snapshot: unknown) => {
      const persisted = save(snapshot);
      if (persisted.status === "indeterminate") {
        const attempted = snapshot as CompiledSessionSnapshot;
        const raw = authoritative.read(attempted.sessionId);
        if (raw.status !== "ok") throw new Error(raw.message);
        const successorHost = createCompiledDurableTestHost();
        const successor = new GameSession(
          attempted.sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, undefined, "preferred", successorHost.runtimeDependencies,
        );
        if (successor.restoreCompiledSession(raw.value, bundle.value).status !== "loaded") throw new Error("successor fixture could not restore");
        const advanced = successorHost.commit(successor, input, "advance-indeterminate-create", 0, (next) => {
          const stored = authoritative.save(next);
          if (stored.status !== "ok") throw new Error(stored.message);
        });
        if (advanced.status !== "committed") throw new Error("successor fixture could not advance durable snapshot");
      }
      return persisted;
    };
    const registry = new Map<string, GameSession>();
    const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, indeterminate, storage, {}, {}, keeperAuthenticator, undefined, undefined, undefined, {}, { registry });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    const body = await response.json() as { error: { code: string; recovery?: { generation: number } } };
    expect(body.error).toEqual(expect.objectContaining({ code: "SNAPSHOT_INDETERMINATE", recovery: expect.objectContaining({ generation: 0 }) }));
    expect(JSON.stringify(body)).not.toContain("snapshotHash");
    expect(registry.size).toBe(0);
  }, 20_000);

  it("keeps the concurrent create winner registered when this real HTTP request loses snapshot CAS", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const id = "create-cas-winner";
    const storage = { careerRoot: join(dir, "careers") };
    const bundle = catalog.loadBundle(saved.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots") });
    const winnerHost = createCompiledDurableTestHost();
    const winner = new GameSession(
      id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, storage, undefined, "preferred", winnerHost.runtimeDependencies,
    );
    if (winner.loadDurableCompiledModule(bundle.value).status !== "loaded") throw new Error("winner fixture could not load");
    const winnerSnapshot = winnerHost.snapshot(winner);
    expect(snapshots.save(winnerSnapshot)).toMatchObject({ status: "ok" });
    winnerHost.acknowledge(winner, winnerSnapshot);
    const registry = new Map<string, GameSession>([[id, winner]]);
    let loserSession: GameSession | undefined;
    const compiledDurableHostCapability = Object.freeze(Object.create(null)) as object;
    const namespace = new SessionNamespaceCoordinator(dir);
    const compiledSessionCreationAdmission = new CompiledSessionCreationAdmissionCoordinator({
      root: namespace.root,
      ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
    });
    const loser = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Bea" }),
    }), {
      compiledDurableHostCapability,
      generateId: () => id,
      hasSession: () => false,
      hasDurableSession: () => false,
      createSession: (sessionId, archetype, characterName, persona) => {
        loserSession = new GameSession(
          sessionId, "cosmic-horror", CONFIG, archetype, characterName, persona, storage, undefined, "preferred", { compiledDurableHostCapability },
        );
        return loserSession;
      },
      persistSession: (_id, _session, _bundleId, snapshot) => {
        const persisted = snapshots.save(snapshot);
        if (persisted.status !== "ok") throw new CompiledSessionSnapshotPersistenceError(persisted.code, persisted.message);
      },
      registerSession: (sessionId, session) => registry.set(sessionId, session as GameSession),
      // Model the production adapter's old unsafe fallback. The expected
      // instance is mandatory: a stale loser must not remove a winner.
      unregisterSession: (sessionId, expected) => {
        if (expected === undefined || registry.get(sessionId) === expected) registry.delete(sessionId);
      },
      authenticateCompilerRequest: keeperAuthenticator,
      catalog,
      compiledSessionCreationAdmission,
    });
    expect(loser?.status).toBe(409);
    expect(await loser?.json()).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "SNAPSHOT_CONFLICT" }) }));
    expect(loserSession).toBeDefined();
    expect(registry.has(id)).toBe(true);
    expect(registry.get(id)).toBe(winner);
  }, 20_000);

  it("keeps a classified generation-zero storage failure internal rather than retryable", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const failed = new CompiledSessionSnapshotStore({
      root: join(dir, "snapshots"),
      coordinatorFactory: () => ({
        initializePolicy: () => undefined,
        beginPublication: () => { throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "forced storage failure"); },
        finishPublication: () => ({}),
      }),
    });
    const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, failed, { careerRoot: join(dir, "careers") }, {}, {}, keeperAuthenticator);
    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "SESSION_INTERNAL" }) }));
  }, 20_000);

  it("maps a typed snapshot quota refusal to a safe fixed HTTP capacity response", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const limited = new CompiledSessionSnapshotStore({
      root: join(dir, "snapshots"),
      coordinatorFactory: () => ({
        initializePolicy: () => undefined,
        beginPublication: () => { throw new SnapshotCoordinatorFailure("SNAPSHOT_QUOTA_EXCEEDED", "C:/private/snapshot root is full"); },
        finishPublication: () => ({}),
      }),
    });
    const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, limited, { careerRoot: join(dir, "careers") }, {}, {}, keeperAuthenticator);
    expect(response.status).toBe(507);
    expect(response.headers.get("Retry-After")).toBeNull();
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual({ error: { stage: "session", code: "SNAPSHOT_QUOTA_EXCEEDED", message: "compiled snapshot capacity is unavailable" } });
    expect(JSON.stringify(payload)).not.toContain("private");
  }, 20_000);

  it("preserves an ambiguous generation-zero publication as retryable recovery", async () => {
    const dir = root();
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const indeterminate = new CompiledSessionSnapshotStore({
      root: join(dir, "snapshots"),
      fileOps: { ...compiledSessionSnapshotNodeFileOps, writeReplace: () => { throw new Error("forced current-header failure"); } },
    });
    const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, indeterminate, { careerRoot: join(dir, "careers") }, {}, {}, keeperAuthenticator);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    const payload = await response.json() as { error: { code: string; recovery?: { sessionId: string; generation: number } } };
    expect(payload.error).toEqual(expect.objectContaining({
      code: "SNAPSHOT_INDETERMINATE",
      recovery: expect.objectContaining({ sessionId: expect.any(String), generation: 0 }),
    }));
    expect(JSON.stringify(payload)).not.toContain("snapshotHash");
  }, 20_000);

  it("classifies header, directory-sync, and coordinator-close ambiguity without refusing a possible commit", async () => {
    const headerDir = root();
    const headerFixture = await competingSuccessors(headerDir);
    const headerFailure = new CompiledSessionSnapshotStore({
      root: headerFixture.store.root,
      fileOps: { ...compiledSessionSnapshotNodeFileOps, writeReplace: () => { throw new Error("header replace failure"); } },
    });
    expect(headerFailure.save(headerFixture.a)).toMatchObject({ status: "indeterminate", code: "SNAPSHOT_INDETERMINATE" });
    expect(headerFixture.store.read("snapshotcas")).toMatchObject({ status: "ok", value: expect.objectContaining({ generation: 0 }) });

    const syncDir = root();
    const syncFixture = await competingSuccessors(syncDir);
    let headerWritten = false;
    const syncFailure = new CompiledSessionSnapshotStore({
      root: syncFixture.store.root,
      fileOps: {
        ...compiledSessionSnapshotNodeFileOps,
        writeReplace(path, value) { compiledSessionSnapshotNodeFileOps.writeReplace(path, value); headerWritten = true; },
        syncDirectory(path) {
          if (headerWritten) throw new Error("header directory sync failure");
          compiledSessionSnapshotNodeFileOps.syncDirectory?.(path);
        },
      },
    });
    expect(syncFailure.save(syncFixture.a)).toMatchObject({ status: "indeterminate", code: "SNAPSHOT_INDETERMINATE" });
    expect(syncFixture.store.read("snapshotcas")).toMatchObject({ status: "ok", value: expect.objectContaining({ snapshotHash: syncFixture.a.snapshotHash, generation: 1 }) });

    const closeDir = root();
    const closeFixture = await competingSuccessors(closeDir);
    const closeFailure = new CompiledSessionSnapshotStore({
      root: closeFixture.store.root,
      coordinatorFactory: () => ({
        initializePolicy: () => undefined,
        beginPublication: () => undefined,
        finishPublication: () => ({ closeFailure: new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "coordinator close failure") }),
      }),
    });
    expect(closeFailure.save(closeFixture.a)).toMatchObject({ status: "indeterminate", code: "SNAPSHOT_INDETERMINATE" });
    expect(closeFixture.store.read("snapshotcas")).toMatchObject({ status: "ok", value: expect.objectContaining({ snapshotHash: closeFixture.a.snapshotHash, generation: 1 }) });
  }, 20_000);
});
