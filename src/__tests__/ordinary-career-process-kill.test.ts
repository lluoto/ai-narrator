import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CareerFileStore } from "../character/career-file";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT, type OrdinarySessionEnvelope, type OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { reconcileRuntimeSessionNamespace } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";

const child = join(import.meta.dir, "ordinary-career-process-kill-child.ts");
const prefix = "@@ordinary-career-kill@@";
const roots = new Set<string>();

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ordinary-career-process-kill-"));
  roots.add(value);
  return value;
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.clear();
});

async function readEvent(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("ordinary Career kill child exited before its fault point");
    pending += decoder.decode(next.value, { stream: true });
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith(prefix)) return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
  }
}

async function crash(rootPath: string, phase: "before-projection-completion" | "during-retired-unlink" | "after-staged-leaf-before-journal" | "before-ordinary-cas" | "after-ordinary-cas" | "after-career-pointer" | "before-namespace-commit") {
  const processHandle = Bun.spawn([process.execPath, child, phase, rootPath], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLM_DISABLED: "1" },
  });
  if (!processHandle.stdout || typeof processHandle.stdout === "number") throw new Error("ordinary Career kill child stdout is unavailable");
  let event: Record<string, unknown>;
  try {
    event = await readEvent(processHandle.stdout);
  } catch (error) {
    const stderr = await new Response(processHandle.stderr).text();
    throw new Error(`${error instanceof Error ? error.message : String(error)}: ${stderr}`);
  }
  return { processHandle, event };
}

async function recover(rootPath: string, mode: "recover" | "recover-and-act" | "recover-after-namespace-reconcile" = "recover"): Promise<Record<string, unknown>> {
  const processHandle = Bun.spawn([process.execPath, child, mode, rootPath], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, LLM_DISABLED: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text(), processHandle.exited,
  ]);
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith(prefix));
  if (code !== 0 || !line) throw new Error(`ordinary Career recovery child failed (${code}): ${stdout}\n${stderr}`);
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}

describe("ordinary Career publication survives real process termination", () => {
  test("a live Career root owner remains fenced, then SIGKILL recovery composes with HTTP action without manual unlink", async () => {
    const storage = root(); let crashed: Awaited<ReturnType<typeof crash>> | undefined;
    try {
      crashed = await crash(storage, "before-projection-completion");
      expect(crashed.event).toEqual({
        event: "fault-point", phase: "before-projection-completion", stage: "projection-leaves-durable-before-completion", sessionId: expect.any(String),
        building: expect.stringMatching(/^building-[0-9a-f-]+$/i), completion: false, rootLock: true, directory: expect.any(String),
        authoritativeRoot: join(storage, "careers", "12345678-1234-4123-8123-123456789abc"), finalRoot: true, staging: false,
        activePointer: expect.stringMatching(/^projection-[0-9a-f-]+$/i), journal: false,
      });
      const careerDirectory = join(storage, "careers", "12345678-1234-4123-8123-123456789abc");
      const versions = join(careerDirectory, ".career-projections");
      expect(crashed.event.directory).toBe(join(versions, String(crashed.event.building)));
      // The paused owner has both the durable lock and its named kernel mutex.
      // A fresh process must not reclaim either while that owner is still live.
      expect(await recover(storage)).toMatchObject({
        event: "recovered", status: "refused", code: "ORDINARY_CAREER_ROOT_LOCK_RECOVERY_REQUIRED", lock: true,
      });
      expect(existsSync(join(careerDirectory, ".career-root.lock"))).toBe(true);
      crashed.processHandle.kill("SIGKILL"); const exitCode = await crashed.processHandle.exited;
      expect(exitCode).not.toBe(0);
      crashed = undefined;
      expect(readdirSync(versions).filter((name) => name.startsWith("building-"))).toHaveLength(1);
      expect(readdirSync(versions).filter((name) => name.startsWith("projection-")).length).toBeGreaterThan(0);
      expect(await recover(storage, "recover-and-act")).toMatchObject({
        event: "recovered", status: "ok", generation: 0, journal: false, lock: false,
        hydratedIdentityPreserved: true, nextOrdinaryActionStatus: 200, postActionGeneration: 1,
      });
      expect(readdirSync(versions).filter((name) => name.startsWith("building-"))).toHaveLength(0);
    } finally {
      if (crashed) { try { crashed.processHandle.kill(); } catch { /* already gone */ } await crashed.processHandle.exited; }
    }
  }, 30_000);

  test("a Career-writer child killed after retired unlink recovers the bounded final-root residual without rewriting recovered identity", async () => {
    const storage = root(); let crashed: Awaited<ReturnType<typeof crash>> | undefined;
    try {
      crashed = await crash(storage, "during-retired-unlink");
      expect(crashed.event).toEqual({
        event: "fault-point", phase: "during-retired-unlink", stage: "retired-stage-partially-unlinked", sessionId: expect.any(String),
        retired: expect.stringMatching(/^retired-projection-[0-9a-f-]+$/i), remainingLeaves: expect.any(Number), rootLock: true,
        orphan: expect.stringMatching(/^projection-[0-9a-f-]+$/i), orphanWasComplete: true, orphanWasUnprotected: true,
        authoritativeRoot: join(storage, "careers", "12345678-1234-4123-8123-123456789abc"), finalRoot: true, staging: false,
        activePointer: expect.stringMatching(/^projection-[0-9a-f-]+$/i), journal: false,
      });
      expect(crashed.event.remainingLeaves).toBeGreaterThanOrEqual(1);
      crashed.processHandle.kill("SIGKILL"); const exitCode = await crashed.processHandle.exited;
      expect(exitCode).not.toBe(0);
      crashed = undefined;
      const careerDirectory = join(storage, "careers", "12345678-1234-4123-8123-123456789abc");
      const versions = join(careerDirectory, ".career-projections");
      expect(readdirSync(versions).some((name) => name.startsWith("retired-projection-"))).toBe(true);
      expect(await recover(storage, "recover-and-act")).toMatchObject({
        event: "recovered", status: "ok", generation: 0, journal: false, lock: false,
        hydratedIdentityPreserved: true, nextOrdinaryActionStatus: 200, postActionGeneration: 1,
      });
      expect(readdirSync(versions).some((name) => name.startsWith("retired-projection-"))).toBe(false);
    } finally {
      if (crashed) { try { crashed.processHandle.kill(); } catch { /* already gone */ } await crashed.processHandle.exited; }
    }
  }, 30_000);

  test("a killed pre-journal stage is reclaimed only after its dead owner is identity-verified", async () => {
    const storage = root(); let crashed: Awaited<ReturnType<typeof crash>> | undefined;
    try {
      crashed = await crash(storage, "after-staged-leaf-before-journal");
      expect(crashed.event).toEqual({
        event: "fault-point", phase: "after-staged-leaf-before-journal", stage: "staged-leaf-durable-before-journal", sessionId: expect.any(String),
        stagedLeaf: true, journal: false, rootLock: true,
      });
      crashed.processHandle.kill(); await crashed.processHandle.exited;
      crashed = undefined;
      const careerDirectory = join(storage, "careers", "12345678-1234-4123-8123-123456789abc");
      const versions = join(careerDirectory, ".career-projections");
      const orphanCount = readdirSync(versions).filter((name) => name.startsWith("projection-")).length;
      expect(orphanCount).toBeGreaterThan(0);
      const writer = new CareerFileStore(careerDirectory);
      const projection = writer.exportPortableProjection();
      expect(() => writer.replacePortableProjection(projection)).not.toThrow();
      const remaining = readdirSync(versions).filter((name) => name.startsWith("projection-"));
      expect(remaining).toHaveLength(1);
    } finally {
      if (crashed) { try { crashed.processHandle.kill(); } catch { /* already gone */ } await crashed.processHandle.exited; }
    }
  }, 30_000);

  test("a child killed after durable journal staging converges only to the exact ordinary predecessor", async () => {
    const storage = root(); const crashed = await crash(storage, "before-ordinary-cas");
    expect(crashed.event).toEqual({
      event: "fault-point", phase: "before-ordinary-cas", stage: "journal-durable-before-ordinary-cas", sessionId: expect.any(String), journal: true, stagedLeaf: true,
    });
    crashed.processHandle.kill(); await crashed.processHandle.exited;
    const recovered = await recover(storage);
    expect(recovered).toMatchObject({
      event: "recovered", status: "ok", generation: 0, envelopeGeneration: 0, namespaceGeneration: 0, journal: false, lock: false,
    });
    expect(recovered.careerProjectionHash).toBe(recovered.snapshotCareerHash);
  }, 30_000);

  test("a child killed after ordinary CAS converges only to the exact staged successor", async () => {
    const storage = root(); const crashed = await crash(storage, "after-ordinary-cas");
    expect(crashed.event).toEqual({
      event: "fault-point", phase: "after-ordinary-cas", stage: "ordinary-and-namespace-durable-before-career-finalize", sessionId: expect.any(String), ordinaryGeneration: 1, namespaceGeneration: 1,
    });
    crashed.processHandle.kill(); await crashed.processHandle.exited;
    const recovered = await recover(storage);
    expect(recovered).toMatchObject({
      event: "recovered", status: "ok", generation: 1, envelopeGeneration: 1, namespaceGeneration: 1, journal: false, lock: false,
    });
    expect(recovered.careerProjectionHash).toBe(recovered.snapshotCareerHash);
  }, 30_000);

  test("a child killed after ordinary E=g1 is durable but before namespace commit advances only through startup reconciliation", async () => {
    const storage = root(); let crashed: Awaited<ReturnType<typeof crash>> | undefined;
    try {
      crashed = await crash(storage, "before-namespace-commit");
      expect(crashed.event).toEqual({
        event: "fault-point", phase: "before-namespace-commit", stage: "ordinary-pointer-durable-before-namespace-commit", sessionId: expect.any(String),
        ordinaryGeneration: 1, journal: true, pointerStillPredecessor: true, stagedSuccessorDiffers: true,
      });
      crashed.processHandle.kill(); await crashed.processHandle.exited;
      crashed = undefined;
      expect(await recover(storage, "recover-after-namespace-reconcile")).toEqual({
        event: "namespace-reconciled",
        beforeHydrate: "ORDINARY_SNAPSHOT_CONFLICT",
        beforeNamespaceGeneration: 0,
        beforeCareerStillPredecessor: true,
        beforeRegistrySize: 0,
        afterNamespaceGeneration: 1,
        httpStatus: 200,
        registrySize: 1,
        careerMatchesEnvelope: true,
        journal: false,
      });
    } finally {
      if (crashed) { try { crashed.processHandle.kill(); } catch { /* already gone */ } await crashed.processHandle.exited; }
    }
  }, 30_000);

  test("startup refuses a poisoned ordinary g1 whose authenticated predecessor hash does not match namespace g0", () => {
    const storageRoot = root();
    const storage = { careerRoot: join(storageRoot, "careers"), sessionRoot: join(storageRoot, "sessions") };
    const id = "12345678-1234-4123-8123-123456789abc";
    const g0Hash = "a".repeat(64);
    const poisoned = {
      sessionId: id,
      envelopeHash: "c".repeat(64),
      generation: 1,
      previousEnvelopeHash: "b".repeat(64),
    } as OrdinarySessionEnvelope;
    // This is a bounded inventory seam, not a mutable namespace fixture: it
    // models a store which has already authenticated E but reports a g0
    // predecessor hash inconsistent with the durable namespace current.
    const ordinary = {
      root: join(storage.sessionRoot, "ordinary-snapshots"),
      listHeaders: () => [{ status: "ok" as const, value: { sessionId: id } }],
      read: () => ({ status: "ok" as const, value: poisoned }),
      listOccupiedSessionIds: () => [id],
    } as unknown as OrdinarySessionSnapshotStore;
    const namespace = new SessionNamespaceCoordinator(storage.sessionRoot);
    namespace.adoptCommitted({
      sessionId: id, kind: "ordinary",
      observedIdentity: { hash: g0Hash, generation: 0, format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT },
    });
    reconcileRuntimeSessionNamespace(
      namespace,
      ordinary,
      new CompiledSessionSnapshotStore({ root: join(storage.sessionRoot, "compiled-snapshots") }),
      storage,
    );
    expect(namespace.read(id)).toMatchObject({ state: "quarantined", reasonCode: "OBSERVED_PREDECESSOR_MISMATCH" });
  });

  test("ordinary predecessor adoption is coordinator-atomic and does not perform a server-side namespace read", () => {
    const storageRoot = root();
    const storage = { careerRoot: join(storageRoot, "careers"), sessionRoot: join(storageRoot, "sessions") };
    const id = "12345678-1234-4123-8123-123456789abc";
    const g0Hash = "a".repeat(64); const g1Hash = "c".repeat(64);
    const ordinary = {
      root: join(storage.sessionRoot, "ordinary-snapshots"),
      listHeaders: () => [{ status: "ok" as const, value: { sessionId: id } }],
      read: () => ({ status: "ok" as const, value: {
        sessionId: id, envelopeHash: g1Hash, generation: 1, previousEnvelopeHash: g0Hash,
      } as OrdinarySessionEnvelope }),
      listOccupiedSessionIds: () => [id],
    } as unknown as OrdinarySessionSnapshotStore;
    const namespace = new SessionNamespaceCoordinator(storage.sessionRoot);
    namespace.adoptCommitted({
      sessionId: id, kind: "ordinary",
      observedIdentity: { hash: g0Hash, generation: 0, format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT },
    });
    const originalRead = namespace.read.bind(namespace);
    namespace.read = (() => { throw new Error("server-side namespace pre-read is a TOCTOU violation"); }) as typeof namespace.read;
    try {
      expect(() => reconcileRuntimeSessionNamespace(
        namespace,
        ordinary,
        new CompiledSessionSnapshotStore({ root: join(storage.sessionRoot, "compiled-snapshots") }),
        storage,
      )).not.toThrow();
    } finally {
      namespace.read = originalRead;
    }
    expect(namespace.read(id)).toMatchObject({
      state: "committed",
      expectedIdentity: { hash: g1Hash, generation: 1, format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT },
    });
  });

  test("a kill while holding the root fence recovers only from the killed owner's identity, never lock age", async () => {
    const storage = root(); const crashed = await crash(storage, "after-career-pointer");
    expect(crashed.event).toMatchObject({
      event: "fault-point", phase: "after-career-pointer", stage: "career-pointer-durable-before-journal-cleanup", sessionId: expect.any(String), journal: true, rootLock: true,
      pointer: { version: 1, active: expect.any(String), projectionHash: expect.any(String) },
    });
    crashed.processHandle.kill(); await crashed.processHandle.exited;
    const careerDirectory = join(storage, "careers", "12345678-1234-4123-8123-123456789abc");
    const lock = join(careerDirectory, ".career-root.lock");
    expect(existsSync(lock)).toBe(true);
    expect(new CareerFileStore(careerDirectory)).toBeInstanceOf(CareerFileStore);
    const recovered = await recover(storage);
    expect(recovered).toMatchObject({
      event: "recovered", status: "ok", generation: 1, envelopeGeneration: 1, namespaceGeneration: 1, journal: false, lock: false,
    });
    expect(recovered.careerProjectionHash).toBe(recovered.snapshotCareerHash);
  }, 30_000);

  test("a legacy or malformed root lock remains fail-closed instead of guessing an owner", () => {
    const careerDirectory = join(root(), "careers", "malformed-lock");
    const store = new CareerFileStore(careerDirectory);
    const projection = store.exportPortableProjection();
    writeFileSync(join(careerDirectory, ".career-root.lock"), "legacy-token-only", { encoding: "utf8", flag: "wx" });
    expect(() => store.replacePortableProjection(projection)).toThrow(expect.objectContaining({
      code: "CAREER_ROOT_LOCK_RECOVERY_REQUIRED",
    }));
    expect(existsSync(join(careerDirectory, ".career-root.lock"))).toBe(true);
  });

  test("a valid live-owner root record is not reclaimed merely because its mutex is no longer held", () => {
    const careerDirectory = join(root(), "careers", "live-owner-lock");
    const store = new CareerFileStore(careerDirectory);
    const projection = store.exportPortableProjection();
    const prototype = CareerFileStore.prototype as unknown as {
      releaseRootWriteLock(lock: unknown): void;
    };
    const original = prototype.releaseRootWriteLock;
    prototype.releaseRootWriteLock = (): void => {
      // Fault only the raw-file release. withRootWriteLock still releases its
      // kernel mutex, leaving a valid record whose owner is this live process.
    };
    try {
      store.replacePortableProjection(projection);
    } finally {
      prototype.releaseRootWriteLock = original;
    }
    const lock = join(careerDirectory, ".career-root.lock");
    expect(existsSync(lock)).toBe(true);
    expect(() => store.replacePortableProjection(projection)).toThrow(expect.objectContaining({
      code: "CAREER_ROOT_LOCK_RECOVERY_REQUIRED",
    }));
    expect(existsSync(lock)).toBe(true);
  });

  test("a mutex-release failure preserves the operation failure and leaves a retryable root", () => {
    const careerDirectory = join(root(), "careers", "mutex-release-failure");
    const store = new CareerFileStore(careerDirectory);
    const projection = store.exportPortableProjection();
    const prototype = CareerFileStore.prototype as unknown as {
      atomicWriteRootControlFile(name: string, text: string, maximumBytes?: number): void;
      releaseRootFence(fence: unknown): void;
    };
    const originalWrite = prototype.atomicWriteRootControlFile;
    const originalRelease = prototype.releaseRootFence;
    const operationFailure = new Error("injected root operation failure");
    const mutexReleaseFailure = new Error("injected mutex release failure");
    prototype.atomicWriteRootControlFile = function (this: CareerFileStore, name: string, text: string, maximumBytes?: number): void {
      if (name === ".career-active.json") throw operationFailure;
      return originalWrite.call(this, name, text, maximumBytes);
    };
    prototype.releaseRootFence = function (this: CareerFileStore, fence: unknown): void {
      originalRelease.call(this, fence);
      throw mutexReleaseFailure;
    };
    let caught: unknown;
    try {
      store.replacePortableProjection(projection);
    } catch (error) {
      caught = error;
    } finally {
      prototype.atomicWriteRootControlFile = originalWrite;
      prototype.releaseRootFence = originalRelease;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Career root operation failed and cleanup could not complete");
    const causes = (caught as Error & { cause?: unknown }).cause;
    expect(causes).toBeInstanceOf(AggregateError);
    expect((causes as AggregateError).errors).toEqual([operationFailure, mutexReleaseFailure]);
    expect(() => store.replacePortableProjection(projection)).not.toThrow();
  });

  test("a competitor replacing a stale lock at the final unlink boundary is never deleted", () => {
    const careerDirectory = join(root(), "careers", "unlink-competitor");
    const store = new CareerFileStore(careerDirectory);
    const projection = store.exportPortableProjection();
    const lock = join(careerDirectory, ".career-root.lock");
    const prototype = CareerFileStore.prototype as unknown as {
      releaseRootWriteLock(lock: unknown): void;
      unlinkExactObservedRootWriteLock(lockPath: string, observed: unknown): void;
    };
    const originalRelease = prototype.releaseRootWriteLock;
    prototype.releaseRootWriteLock = (): void => {
      // Leave a real, schema-valid root record for the recovery path.
    };
    try {
      store.replacePortableProjection(projection);
    } finally {
      prototype.releaseRootWriteLock = originalRelease;
    }
    const stale = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
    writeFileSync(lock, JSON.stringify({ ...stale, pid: 0xffff_ffff, creationFiletime: "1" }), "utf8");
    const originalUnlink = prototype.unlinkExactObservedRootWriteLock;
    let replaced = false;
    prototype.unlinkExactObservedRootWriteLock = function (this: CareerFileStore, lockPath: string, observed: unknown): void {
      if (!replaced) {
        replaced = true;
        unlinkSync(lockPath);
        writeFileSync(lockPath, "competing-root-lock", { encoding: "utf8", flag: "wx" });
      }
      return originalUnlink.call(this, lockPath, observed);
    };
    try {
      expect(() => store.replacePortableProjection(projection)).toThrow(expect.objectContaining({
        code: "CAREER_ROOT_LOCK_RECOVERY_REQUIRED",
      }));
    } finally {
      prototype.unlinkExactObservedRootWriteLock = originalUnlink;
    }
    expect(replaced).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe("competing-root-lock");
  });
});
