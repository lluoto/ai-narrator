import { describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CareerFileStore } from "../character/career-file";
import type { CharacterSnapshot } from "../character/career";
import { tryAcquireCareerRootFence } from "../character/win32-career-root-fence";

const NAME = "Concurrent Investigator";
const PREFIX = "@@career-file-concurrency@@";
const childPath = join(import.meta.dir, "career-file-concurrency-child.ts");

type ChildEvent = { event: string; id: string; message?: string };

function snapshot(): CharacterSnapshot {
  return {
    characterName: NAME,
    occupation: "Detective",
    attributes: { strength: 50 },
    skills: { SpotHidden: 60 },
    san: 55,
    maxSan: 99,
    cthulhuMythos: 0,
    hp: 11,
    maxHp: 11,
    creditRating: 35,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function entry(id: string, narrative: string) {
  return {
    id,
    characterName: NAME,
    moduleId: "concurrency-module",
    moduleName: "Concurrency Module",
    completedAt: "2026-09-29T00:00:00.000Z",
    endingId: "completed",
    endingName: "Completed",
    sanChange: 0,
    cmChange: 0,
    reputationChange: 0,
    skillChanges: [],
    rewardIds: [],
    narrative,
  };
}

function lockFiles(root: string): string[] {
  return readdirSync(root)
    .filter((name) => name.endsWith(".lock") && name !== ".career-root.lock")
    .sort();
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function detectsFileSymlinkCapability(): boolean {
  const root = mkdtempSync(join(tmpdir(), "career-file-lock-symlink-capability-"));
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "target", "utf8");
    symlinkSync(target, link, "file");
    if (!lstatSync(link).isSymbolicLink()) throw new Error("file symlink probe created a non-symlink");
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") return false;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FILE_SYMLINK_SUPPORTED = detectsFileSymlinkCapability();

function supportsExactLocalCareerLockRecovery(): boolean {
  if (process.platform !== "win32") return false;
  const attempt = tryAcquireCareerRootFence(tmpdir());
  if (attempt.kind !== "held") return false;
  try {
    return true;
  } finally {
    attempt.mutex.release();
  }
}

const EXACT_LOCAL_CAREER_LOCK_RECOVERY_SUPPORTED = supportsExactLocalCareerLockRecovery();

function spawnWriter(root: string, barrier: string, id: string, narrative: string, mode: "pause" | "plain" | "throw") {
  const releasePath = join(barrier, `${id}-${crypto.randomUUID()}.release`);
  const processHandle = Bun.spawn([process.execPath, childPath, root, NAME, id, narrative, mode, releasePath], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const events: ChildEvent[] = [];
  let abandoned = false;
  let wake: (() => void) | undefined;
  let stdout = "";
  let stderr = "";
  let pending = "";
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of processHandle.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      stdout += text; pending += text;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line.startsWith(PREFIX)) continue;
        events.push(JSON.parse(line.slice(PREFIX.length)) as ChildEvent);
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
        if (!events.length) throw new Error(`career writer exited before an event: ${stdout}\n${stderr}`);
      }
    }
    return events.shift()!;
  };
  return {
    next,
    release() { writeFileSync(releasePath, "release", "utf8"); },
    kill() {
      abandoned = true;
      processHandle.kill("SIGKILL");
    },
    async finish() {
      const code = await processHandle.exited;
      await Promise.all([stdoutDrain, stderrDrain]);
      return { code, stdout, stderr, events };
    },
    async dispose() {
      try { if (!abandoned && !existsSync(releasePath)) this.release(); } catch { /* Child may have exited. */ }
      try { await processHandle.exited; } catch { /* Child failure is observed by the test. */ }
      try { await Promise.all([stdoutDrain, stderrDrain]); } catch { /* Child failure is observed by the test. */ }
    },
  };
}

describe("CareerFileStore cross-process coordination", () => {
  it("does not lose either entry when two independent stores overlap the read-write window", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const alpha = spawnWriter(root, barrier, "alpha", "alpha entry", "pause");
    let beta: ReturnType<typeof spawnWriter> | undefined;
    let retry: ReturnType<typeof spawnWriter> | undefined;
    try {
      expect((await alpha.next()).event).toBe("ready");
      beta = spawnWriter(root, barrier, "beta", "beta entry", "pause");
      const betaInitial = await beta.next();
      if (betaInitial.event === "ready") {
        // The old uncoordinated implementation reaches this branch. Releasing
        // both real writes deterministically exposes its lost update below.
        alpha.release();
        beta.release();
        expect((await alpha.finish()).code).toBe(0);
        expect((await beta.finish()).code).toBe(0);
      } else {
        expect(betaInitial).toMatchObject({ event: "error", id: "beta", message: expect.stringContaining("write lock") });
        expect((await beta.finish()).code).toBe(1);
        alpha.release();
        expect((await alpha.finish()).code).toBe(0);
        retry = spawnWriter(root, barrier, "beta", "beta entry", "plain");
        expect(await retry.next()).toMatchObject({ event: "success", id: "beta" });
        expect((await retry.finish()).code).toBe(0);
      }
      expect(store.getEntries(NAME).map((entry) => entry.id).sort()).toEqual(["alpha", "beta"]);
      expect(lockFiles(root)).toEqual([]);
    } finally {
      await alpha.dispose();
      await beta?.dispose();
      await retry?.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it("retries an identical concurrent ID as a no-op after the held writer releases", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const first = spawnWriter(root, barrier, "same", "same entry", "pause");
    let competing: ReturnType<typeof spawnWriter> | undefined;
    let retry: ReturnType<typeof spawnWriter> | undefined;
    try {
      expect(await first.next()).toMatchObject({ event: "ready", id: "same" });
      competing = spawnWriter(root, barrier, "same", "same entry", "pause");
      expect(await competing.next()).toMatchObject({ event: "error", id: "same", message: expect.stringContaining("write lock") });
      expect((await competing.finish()).code).toBe(1);
      first.release();
      expect((await first.finish()).code).toBe(0);
      retry = spawnWriter(root, barrier, "same", "same entry", "plain");
      expect(await retry.next()).toMatchObject({ event: "success", id: "same" });
      expect((await retry.finish()).code).toBe(0);
      expect(store.getEntries(NAME)).toEqual([entry("same", "same entry")]);
      expect(lockFiles(root)).toEqual([]);
    } finally {
      await first.dispose();
      await competing?.dispose();
      await retry?.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting concurrent ID after the held writer releases without overwriting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const first = spawnWriter(root, barrier, "shared", "first content", "pause");
    let competing: ReturnType<typeof spawnWriter> | undefined;
    let retry: ReturnType<typeof spawnWriter> | undefined;
    try {
      expect(await first.next()).toMatchObject({ event: "ready", id: "shared" });
      competing = spawnWriter(root, barrier, "shared", "conflicting content", "pause");
      expect(await competing.next()).toMatchObject({ event: "error", id: "shared", message: expect.stringContaining("write lock") });
      expect((await competing.finish()).code).toBe(1);
      first.release();
      expect((await first.finish()).code).toBe(0);
      retry = spawnWriter(root, barrier, "shared", "conflicting content", "plain");
      expect(await retry.next()).toMatchObject({ event: "error", id: "shared", message: expect.stringContaining("already exists") });
      expect((await retry.finish()).code).toBe(1);
      expect(store.getEntries(NAME)).toEqual([entry("shared", "first content")]);
      expect(lockFiles(root)).toEqual([]);
    } finally {
      await first.dispose();
      await competing?.dispose();
      await retry?.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it("rejects an externally held lock without deleting it, then removes only its own lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const holder = spawnWriter(root, barrier, "holder", "held entry", "pause");
    let outsider: ReturnType<typeof spawnWriter> | undefined;
    try {
      expect(await holder.next()).toMatchObject({ event: "ready", id: "holder" });
      const heldLocks = lockFiles(root);
      expect(heldLocks).toHaveLength(1);
      outsider = spawnWriter(root, barrier, "outsider", "outside entry", "plain");
      expect(await outsider.next()).toMatchObject({ event: "error", id: "outsider", message: expect.stringContaining("write lock") });
      expect((await outsider.finish()).code).toBe(1);
      expect(lockFiles(root)).toEqual(heldLocks);
      holder.release();
      expect((await holder.finish()).code).toBe(0);
      expect(lockFiles(root)).toEqual([]);
    } finally {
      await holder.dispose();
      await outsider?.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it.skipIf(!EXACT_LOCAL_CAREER_LOCK_RECOVERY_SUPPORTED)("recovers only a killed writer's exact leaf record after root recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const killed = spawnWriter(root, barrier, "killed", "must not persist", "pause");
    let recovered: ReturnType<typeof spawnWriter> | undefined;
    try {
      expect(await killed.next()).toMatchObject({ event: "ready", id: "killed" });
      const lockName = lockFiles(root).at(0);
      if (!lockName) throw new Error("killed writer did not create a character lock");
      const leafLock = join(root, lockName);
      expect(existsSync(join(root, ".career-root.lock"))).toBe(true);

      killed.kill();
      expect((await killed.finish()).code).not.toBe(0);
      expect(existsSync(join(root, ".career-root.lock"))).toBe(true);
      expect(existsSync(leafLock)).toBe(true);

      recovered = spawnWriter(root, barrier, "after-kill", "recovered after killed writer", "plain");
      expect(await recovered.next()).toMatchObject({ event: "success", id: "after-kill" });
      expect((await recovered.finish()).code).toBe(0);
      expect(store.getEntries(NAME)).toEqual([entry("after-kill", "recovered after killed writer")]);
      expect(existsSync(join(root, ".career-root.lock"))).toBe(false);
      expect(lockFiles(root)).toEqual([]);
    } finally {
      await killed.dispose();
      await recovered?.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!EXACT_LOCAL_CAREER_LOCK_RECOVERY_SUPPORTED)("never reclaims a schema-valid leaf record while its exact owner remains live", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const prototype = CareerFileStore.prototype as unknown as {
      releaseWriteLock(lock: unknown): void;
    };
    const originalRelease = prototype.releaseWriteLock;
    try {
      try {
        prototype.releaseWriteLock = (): void => {
          // Leave the real record from this live process in place after its root
          // fence is released, so recovery must inspect owner identity.
        };
        store.addEntry(entry("live-owner", "must retain live lock"));
      } finally {
        prototype.releaseWriteLock = originalRelease;
      }
      const lockName = lockFiles(root).at(0);
      if (!lockName) throw new Error("live writer did not leave a character lock");
      const leafLock = join(root, lockName);
      expect(JSON.parse(readFileSync(leafLock, "utf8"))).toMatchObject({
        version: 1,
        token: expect.any(String),
        pid: expect.any(Number),
        creationFiletime: expect.any(String),
      });
      const before = lstatSync(leafLock);
      const bytes = readFileSync(leafLock, "utf8");
      expect(() => new CareerFileStore(root).addEntry(entry("blocked-live-owner", "must not steal lock"))).toThrow("write lock");
      const after = lstatSync(leafLock);
      expect(readFileSync(leafLock, "utf8")).toBe(bytes);
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
    } finally {
      prototype.releaseWriteLock = originalRelease;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!EXACT_LOCAL_CAREER_LOCK_RECOVERY_SUPPORTED)("does not delete a character lock replaced at the dead-owner recovery unlink boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const prototype = CareerFileStore.prototype as unknown as {
      releaseWriteLock(lock: unknown): void;
      unlinkExactObservedWriteLock(characterName: string, lockPath: string, observed: unknown): void;
    };
    const originalRelease = prototype.releaseWriteLock;
    const originalUnlink = prototype.unlinkExactObservedWriteLock;
    try {
      prototype.releaseWriteLock = (): void => {
        // Retain one real, schema-valid record, then turn it into a proved-dead
        // owner so only the final unlink boundary remains under test.
      };
      store.addEntry(entry("recovery-race-setup", "retain lock for recovery race"));
      prototype.releaseWriteLock = originalRelease;

      const lockName = lockFiles(root).at(0);
      if (!lockName) throw new Error("setup writer did not leave a character lock");
      const leafLock = join(root, lockName);
      const stale = JSON.parse(readFileSync(leafLock, "utf8")) as Record<string, unknown>;
      writeFileSync(leafLock, JSON.stringify({ ...stale, pid: 0xffff_ffff, creationFiletime: "1" }), "utf8");
      let replaced = false;
      prototype.unlinkExactObservedWriteLock = function (this: CareerFileStore, characterName: string, lockPath: string, observed: unknown): void {
        if (!replaced) {
          replaced = true;
          unlinkSync(lockPath);
          writeFileSync(lockPath, "competing-character-lock", { encoding: "utf8", flag: "wx" });
        }
        return originalUnlink.call(this, characterName, lockPath, observed);
      };

      expect(() => store.addEntry(entry("recovery-race", "must not delete competitor"))).toThrow("write lock");
      expect(replaced).toBe(true);
      expect(readFileSync(leafLock, "utf8")).toBe("competing-character-lock");
    } finally {
      prototype.releaseWriteLock = originalRelease;
      prototype.unlinkExactObservedWriteLock = originalUnlink;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed over a pre-existing foreign lock without automatic reclaim", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const holder = spawnWriter(root, barrier, "holder", "held entry", "pause");
    try {
      expect(await holder.next()).toMatchObject({ event: "ready", id: "holder" });
      const lockName = lockFiles(root).at(0);
      if (!lockName) throw new Error("held writer did not create a lock");
      holder.release();
      expect((await holder.finish()).code).toBe(0);

      const foreignLock = join(root, lockName);
      writeFileSync(foreignLock, "foreign stale lock", { encoding: "utf8", mode: 0o600 });
      const before = lstatSync(foreignLock);
      const bytes = readFileSync(foreignLock, "utf8");
      expect(() => store.addEntry(entry("blocked", "blocked by foreign lock"))).toThrow("write lock");
      const after = lstatSync(foreignLock);
      expect(readFileSync(foreignLock, "utf8")).toBe(bytes);
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(lockFiles(root)).toEqual([lockName]);
      expect(store.getEntries(NAME)).toEqual([entry("holder", "held entry")]);
    } finally {
      await holder.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it("fails closed over legacy, malformed, and unknown-version character locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const holder = spawnWriter(root, barrier, "holder", "held entry", "pause");
    try {
      expect(await holder.next()).toMatchObject({ event: "ready", id: "holder" });
      const lockName = lockFiles(root).at(0);
      if (!lockName) throw new Error("held writer did not create a lock");
      holder.release();
      expect((await holder.finish()).code).toBe(0);

      const leafLock = join(root, lockName);
      for (const [label, contents] of [
        ["legacy", crypto.randomUUID()],
        ["malformed", '{"version":1'],
        ["unknown-version", JSON.stringify({ version: 2, token: crypto.randomUUID(), pid: 0xffff_ffff, creationFiletime: "1" })],
      ]) {
        writeFileSync(leafLock, contents, { encoding: "utf8", mode: 0o600 });
        const before = lstatSync(leafLock);
        expect(() => new CareerFileStore(root).addEntry(entry(`blocked-${label}`, `blocked by ${label} lock`))).toThrow("write lock");
        const after = lstatSync(leafLock);
        expect(readFileSync(leafLock, "utf8")).toBe(contents);
        expect(after.dev).toBe(before.dev);
        expect(after.ino).toBe(before.ino);
        unlinkSync(leafLock);
      }
      expect(store.getEntries(NAME)).toEqual([entry("holder", "held entry")]);
    } finally {
      await holder.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it("puts every public mutation behind the same held-character lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const exported = store.exportToJson(NAME);
    if (!exported) throw new Error("seeded career must export before contention");
    const holder = spawnWriter(root, barrier, "holder", "held entry", "pause");
    try {
      expect(await holder.next()).toMatchObject({ event: "ready", id: "holder" });
      const heldLocks = lockFiles(root);
      expect(() => store.saveSnapshot({ ...snapshot(), san: 54 })).toThrow("write lock");
      expect(() => store.deleteSnapshot(NAME)).toThrow("write lock");
      expect(() => store.deleteEntry("holder")).toThrow("write lock");
      expect(store.importFromJson(exported)).toBe(false);
      expect(lockFiles(root)).toEqual(heldLocks);
      holder.release();
      expect((await holder.finish()).code).toBe(0);
      expect(store.getSnapshot(NAME)?.san).toBe(55);
      expect(store.getEntries(NAME)).toEqual([entry("holder", "held entry")]);
      expect(lockFiles(root)).toEqual([]);
    } finally {
      await holder.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it("cleans its own lock when an in-lock write throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const failing = spawnWriter(root, barrier, "failing", "must not persist", "throw");
    try {
      expect(await failing.next()).toMatchObject({ event: "ready", id: "failing" });
      expect(await failing.next()).toMatchObject({ event: "error", id: "failing", message: "forced test wrapper failure" });
      expect((await failing.finish()).code).toBe(1);
      expect(lockFiles(root)).toEqual([]);
      expect(store.getEntries(NAME)).toEqual([]);
    } finally {
      await failing.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it("does not delete a lock leaf replaced after acquisition", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const holder = spawnWriter(root, barrier, "replaced", "write outcome is uncertain", "pause");
    try {
      expect(await holder.next()).toMatchObject({ event: "ready", id: "replaced" });
      const lockName = lockFiles(root).at(0);
      if (!lockName) throw new Error("held writer did not create a lock");
      const lockPath = join(root, lockName);
      unlinkSync(lockPath);
      writeFileSync(lockPath, "foreign replacement", { encoding: "utf8", mode: 0o600 });
      const before = lstatSync(lockPath);

      holder.release();
      expect(await holder.next()).toMatchObject({
        event: "error",
        id: "replaced",
        message: expect.stringContaining("replaced by a different filesystem object"),
      });
      expect((await holder.finish()).code).toBe(1);
      const after = lstatSync(lockPath);
      expect(readFileSync(lockPath, "utf8")).toBe("foreign replacement");
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(lockFiles(root)).toEqual([lockName]);
    } finally {
      await holder.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it.skipIf(!FILE_SYMLINK_SUPPORTED)("rejects a symlink substituted at the derived lock path without touching its target", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-concurrency-"));
    const barrier = mkdtempSync(join(tmpdir(), "career-file-concurrency-barrier-"));
    const outside = mkdtempSync(join(tmpdir(), "career-file-lock-outside-"));
    const store = new CareerFileStore(root);
    store.saveSnapshot(snapshot());
    const holder = spawnWriter(root, barrier, "holder", "held entry", "pause");
    try {
      expect(await holder.next()).toMatchObject({ event: "ready", id: "holder" });
      const lockName = lockFiles(root).at(0);
      if (!lockName) throw new Error("held writer did not create a lock");
      const lockPath = join(root, lockName);
      holder.release();
      expect((await holder.finish()).code).toBe(0);
      const outsideLock = join(outside, "outside.lock");
      writeFileSync(outsideLock, "outside lock must survive", "utf8");
      symlinkSync(outsideLock, lockPath, "file");

      expect(() => store.addEntry(entry("blocked", "blocked by symlink"))).toThrow("symlink or reparse point");
      expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(outsideLock, "utf8")).toBe("outside lock must survive");
    } finally {
      await holder.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(barrier, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
