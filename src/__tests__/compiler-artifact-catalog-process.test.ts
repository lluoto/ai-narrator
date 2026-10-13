import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompilerArtifactCatalog, compilerArtifactCatalogNodeFileOps } from "../compiler/compiler-artifact-catalog";
import { CompilerArtifactCatalogCoordinator } from "../compiler/compiler-artifact-catalog-coordinator";
import { Database } from "bun:sqlite";

const child = join(import.meta.dir, "compiler-artifact-catalog-process-child.ts");
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "compiler-catalog-process-"));
  roots.add(value);
  return value;
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000); });
  return Promise.race([promise, expiry]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
}

interface ProcessHandle {
  process: ReturnType<typeof Bun.spawn>;
  ready: Promise<void>;
  finish(): Promise<{ code: number; stdout: string; stderr: string; result: { status: string; code?: string; value?: { createdAt?: string } } }>;
}

function spawnCatalog(rootPath: string, entryCharacter: string, options: { hold?: "usage" | "temp-flush"; maxEntries?: number; maxBytes?: number; now?: string; coordinatorSchemaVersion?: string } = {}): ProcessHandle {
  const childProcess = Bun.spawn([process.execPath, child], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CATALOG_PROCESS_ROOT: rootPath,
      CATALOG_PROCESS_ID: entryCharacter,
      CATALOG_PROCESS_HOLD: options.hold ?? "",
      CATALOG_PROCESS_MAX_ENTRIES: `${options.maxEntries ?? 1000}`,
      CATALOG_PROCESS_MAX_BYTES: `${options.maxBytes ?? 128 * 1024 * 1024}`,
      CATALOG_PROCESS_NOW: options.now ?? "2026-08-01T00:00:00.000Z",
      CATALOG_PROCESS_COORDINATOR_SCHEMA: options.coordinatorSchemaVersion ?? "",
    },
  });
  let stdout = "", stderr = "", readyResolve: (() => void) | undefined, stdoutLineBuffer = "";
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const drain = async (stream: ReadableStream<Uint8Array>, assign: (value: string) => void, observesReady: boolean) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      assign(text);
      if (observesReady) {
        stdoutLineBuffer += text;
        for (;;) {
          const end = stdoutLineBuffer.indexOf("\n");
          if (end < 0) break;
          const line = stdoutLineBuffer.slice(0, end); stdoutLineBuffer = stdoutLineBuffer.slice(end + 1);
          try { if ((JSON.parse(line) as { event?: string }).event?.startsWith("ready-after-")) readyResolve?.(); } catch { /* result/error text is diagnosed by finish */ }
        }
      }
    }
    const tail = decoder.decode();
    if (tail) { assign(tail); if (observesReady) stdoutLineBuffer += tail; }
  };
  const stdoutDrain = drain(childProcess.stdout, (value) => { stdout += value; }, true);
  const stderrDrain = drain(childProcess.stderr, (value) => { stderr += value; }, false);
  return {
    process: childProcess,
    ready,
    async finish() {
      const code = await within(childProcess.exited, "child exit");
      await within(Promise.all([stdoutDrain, stderrDrain]), "child output drain");
      const line = stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => value.includes('"event":"result"'));
      if (!line) throw new Error(`catalog child omitted result (exit ${code}): ${stderr}`);
      return { code, stdout, stderr, result: JSON.parse(line).result };
    },
  };
}

function release(handle: ProcessHandle): void {
  const stdin = handle.process.stdin;
  if (!stdin || typeof stdin === "number") throw new Error("catalog child stdin pipe is unavailable");
  stdin.write("x");
  stdin.end();
}

describe("CompilerArtifactCatalog cross-process coordinator", () => {
  it("refuses a competing writer while the holder has already scanned quota, then enforces maxEntries on retry", async () => {
    const catalogRoot = root();
    const first = spawnCatalog(catalogRoot, "a", { hold: "usage", maxEntries: 1, now: "2026-08-01T00:00:00.000Z" });
    await within(first.ready, "first writer READY after usage scan");
    const second = spawnCatalog(catalogRoot, "b", { maxEntries: 1 });
    const secondResult = await second.finish();
    release(first);
    const firstResult = await first.finish();
    const retry = await spawnCatalog(catalogRoot, "b", { maxEntries: 1 }).finish();

    const formalEntries = readdirSync(join(catalogRoot, "prepared")).filter((name) => /^[a-z2-7]{24}\.json$/.test(name));
    // A pre-coordinator mutation lets B return ok and leaves two files here:
    // this single assertion keeps both the interleaving and durable overrun red.
    expect({ secondResult, firstResult, retry, formalEntries }).toMatchObject({
      secondResult: { code: 0, result: { status: "refused", code: "CATALOG_BUSY" } },
      firstResult: { code: 0, result: { status: "ok" } },
      retry: { code: 0, result: { status: "refused", code: "CATALOG_QUOTA_EXCEEDED" } },
      formalEntries: [`${"a".repeat(24)}.json`],
    });
  });

  it("returns the durable same-ID metadata after its busy holder releases", async () => {
    const catalogRoot = root();
    const first = spawnCatalog(catalogRoot, "c", { hold: "usage", maxEntries: 1, now: "2026-08-02T00:00:00.000Z" });
    await within(first.ready, "same-ID writer READY");
    const busy = await spawnCatalog(catalogRoot, "c", { maxEntries: 1, now: "2026-08-02T01:00:00.000Z" }).finish();
    release(first);
    const published = await first.finish();
    const retried = await spawnCatalog(catalogRoot, "c", { maxEntries: 1, now: "2026-08-02T02:00:00.000Z" }).finish();

    expect(busy.result).toMatchObject({ status: "refused", code: "CATALOG_BUSY" });
    expect(published.result).toMatchObject({ status: "ok", value: { createdAt: "2026-08-02T00:00:00.000Z" } });
    expect(retried.result).toMatchObject({ status: "ok", value: { createdAt: "2026-08-02T00:00:00.000Z" } });
  });

  it("persists one policy for the root instead of letting a second process reinterpret quota", async () => {
    const catalogRoot = root();
    expect((await spawnCatalog(catalogRoot, "d", { maxEntries: 1 }).finish()).result).toMatchObject({ status: "ok" });
    expect((await spawnCatalog(catalogRoot, "e", { maxEntries: 2 }).finish()).result).toMatchObject({ status: "refused", code: "CATALOG_POLICY_MISMATCH" });
    expect((await spawnCatalog(catalogRoot, "f", { maxEntries: 1, coordinatorSchemaVersion: "test-policy-schema-mismatch" }).finish()).result).toMatchObject({ status: "refused", code: "CATALOG_POLICY_MISMATCH" });
    expect((await spawnCatalog(catalogRoot, "g", { maxEntries: 1, maxBytes: 1 }).finish()).result).toMatchObject({ status: "refused", code: "CATALOG_POLICY_MISMATCH" });
  });

  it("enforces the persisted byte quota across separate writers", async () => {
    const sizingRoot = root();
    expect((await spawnCatalog(sizingRoot, "n").finish()).result).toMatchObject({ status: "ok" });
    const singleBytes = new TextEncoder().encode(readFileSync(join(sizingRoot, "prepared", `${"n".repeat(24)}.json`), "utf8")).length;
    const catalogRoot = root();
    const maxBytes = singleBytes * 2 - 1;
    const first = spawnCatalog(catalogRoot, "o", { hold: "usage", maxBytes });
    await within(first.ready, "byte-quota holder READY after usage scan");
    expect((await spawnCatalog(catalogRoot, "p", { maxBytes }).finish()).result).toMatchObject({ status: "refused", code: "CATALOG_BUSY" });
    release(first);
    expect((await first.finish()).result).toMatchObject({ status: "ok" });
    expect((await spawnCatalog(catalogRoot, "p", { maxBytes }).finish()).result).toMatchObject({ status: "refused", code: "CATALOG_QUOTA_EXCEEDED" });
    const durableBytes = readdirSync(join(catalogRoot, "prepared"))
      .filter((name) => /^[a-z2-7]{24}\.json$/.test(name))
      .reduce((sum, name) => sum + new TextEncoder().encode(readFileSync(join(catalogRoot, "prepared", name), "utf8")).length, 0);
    expect(durableBytes).toBeLessThanOrEqual(maxBytes);
  });

  it("releases the SQLite OS lock when a held writer is killed", async () => {
    const catalogRoot = root();
    const holder = spawnCatalog(catalogRoot, "g", { hold: "usage", maxEntries: 1 });
    await within(holder.ready, "killable holder READY");
    holder.process.kill();
    await within(holder.process.exited, "killed holder exit");
    expect((await spawnCatalog(catalogRoot, "g", { maxEntries: 1 }).finish()).result).toMatchObject({ status: "ok" });
  });

  const windowsOnly = process.platform === "win32" ? it : it.skip;
  windowsOnly("shares the lock through a Windows case alias", async () => {
    const catalogRoot = root();
    const first = spawnCatalog(catalogRoot, "h", { hold: "usage", maxEntries: 1 });
    await within(first.ready, "alias holder READY");
    const competing = await spawnCatalog(catalogRoot.toUpperCase(), "i", { maxEntries: 1 }).finish();
    release(first);
    await first.finish();
    expect(competing.result).toMatchObject({ status: "refused", code: "CATALOG_BUSY" });
  });

  it("cleans only strictly named private temps and leaves unknown stage files intact", async () => {
    const catalogRoot = root();
    const stage = join(catalogRoot, "prepared");
    const stale = `${"j".repeat(24)}.json.${"a".repeat(16)}.tmp`;
    const sentinel = "operator-notes.tmp";
    const catalog = new CompilerArtifactCatalog({ root: catalogRoot, generateId: () => "k".repeat(24) });
    // Create the stage through a normal durable publication, then simulate a crash-private temp and an operator file.
    const fixture = await import("./helpers/compiled-module-http-fixture").then(({ compiledModuleHttpFixture }) => compiledModuleHttpFixture());
    expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "ok" });
    writeFileSync(join(stage, stale), "private");
    writeFileSync(join(stage, sentinel), "keep");
    expect(new CompilerArtifactCatalog({ root: catalogRoot, generateId: () => "l".repeat(24) }).savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "ok" });
    expect(existsSync(join(stage, stale))).toBe(false);
    expect(readFileSync(join(stage, sentinel), "utf8")).toBe("keep");
  });

  it("fails closed for a matching private-temp link or cleanup-sync error before a new target can publish", async () => {
    const catalogRoot = root();
    const fixture = await import("./helpers/compiled-module-http-fixture").then(({ compiledModuleHttpFixture }) => compiledModuleHttpFixture());
    const first = new CompilerArtifactCatalog({ root: catalogRoot, generateId: () => "j".repeat(24) });
    expect(first.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "ok" });
    const stage = join(catalogRoot, "prepared");
    const stale = `${"k".repeat(24)}.json.${"b".repeat(16)}.tmp`;
    writeFileSync(join(stage, stale), "private");
    let published = false;
    const linkLike = new CompilerArtifactCatalog({
      root: catalogRoot,
      generateId: () => "l".repeat(24),
      fileOps: {
        ...compilerArtifactCatalogNodeFileOps,
        isRegularFile: (path) => path.endsWith(stale) ? false : compilerArtifactCatalogNodeFileOps.isRegularFile(path),
        publish: () => { published = true; },
      },
    });
    expect(linkLike.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
    expect(published).toBe(false);
    expect(existsSync(join(stage, stale))).toBe(true);

    const cleanupSync = new CompilerArtifactCatalog({
      root: catalogRoot,
      generateId: () => "m".repeat(24),
      fileOps: {
        ...compilerArtifactCatalogNodeFileOps,
        syncDirectory: (path) => { if (path === stage) throw new Error("cleanup sync failed"); },
        publish: () => { published = true; },
      },
    });
    // Restore a regular private file for this independent cleanup-sync branch.
    expect(cleanupSync.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
    expect(published).toBe(false);
    expect(existsSync(join(stage, `${"m".repeat(24)}.json`))).toBe(false);
  });

  it("cleans a flushed private temp after its writer is killed without touching an unknown stage file", async () => {
    const catalogRoot = root();
    const holder = spawnCatalog(catalogRoot, "s", { hold: "temp-flush", maxEntries: 1 });
    await within(holder.ready, "temp writer READY after flush");
    const stage = join(catalogRoot, "prepared");
    writeFileSync(join(stage, "operator-sentinel.tmp"), "keep");
    holder.process.kill();
    await within(holder.process.exited, "flushed temp writer exit");
    expect((await spawnCatalog(catalogRoot, "t", { maxEntries: 1 }).finish()).result).toMatchObject({ status: "ok" });
    expect(readdirSync(stage).filter((name) => /^[a-z2-7]{24}\.json\.[a-f0-9]{16}\.tmp$/.test(name))).toEqual([]);
    expect(readFileSync(join(stage, "operator-sentinel.tmp"), "utf8")).toBe("keep");
  });

  it("creates a missing root one directory at a time and does not proceed after parent sync failure", async () => {
    const base = root();
    const catalogRoot = join(base, "missing", "nested", "catalog");
    const fixture = await import("./helpers/compiled-module-http-fixture").then(({ compiledModuleHttpFixture }) => compiledModuleHttpFixture());
    const syncs: string[] = [];
    const catalog = new CompilerArtifactCatalog({
      root: catalogRoot,
      generateId: () => "m".repeat(24),
      fileOps: {
        ...compilerArtifactCatalogNodeFileOps,
        syncDirectory(path) {
          syncs.push(path);
          if (path === join(base, "missing", "nested")) throw new Error("parent sync failed");
        },
      },
    });
    expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
    expect(syncs).toContain(join(base, "missing", "nested"));
    expect(existsSync(join(catalogRoot, ".catalog-write.sqlite"))).toBe(false);
    expect(existsSync(join(catalogRoot, "prepared"))).toBe(false);
  });

  it("syncs a pre-created root after policy initialization before it can publish", async () => {
    const catalogRoot = root();
    mkdirSync(join(catalogRoot, "prepared"));
    const fixture = await import("./helpers/compiled-module-http-fixture").then(({ compiledModuleHttpFixture }) => compiledModuleHttpFixture());
    const syncs: string[] = [];
    const catalog = new CompilerArtifactCatalog({
      root: catalogRoot,
      generateId: () => "u".repeat(24),
      fileOps: { ...compilerArtifactCatalogNodeFileOps, syncDirectory: (path) => { syncs.push(path); } },
    });
    expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "ok" });
    expect(syncs).toContain(catalogRoot);

    const blockedRoot = root();
    mkdirSync(join(blockedRoot, "prepared"));
    const blocked = new CompilerArtifactCatalog({
      root: blockedRoot,
      generateId: () => "v".repeat(24),
      fileOps: { ...compilerArtifactCatalogNodeFileOps, syncDirectory: (path) => { if (path === blockedRoot) throw new Error("root sync failed"); } },
    });
    expect(blocked.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
    expect(readdirSync(join(blockedRoot, "prepared")).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("rejects foreign database links and directory paths before opening SQLite", async () => {
    const fixture = await import("./helpers/compiled-module-http-fixture").then(({ compiledModuleHttpFixture }) => compiledModuleHttpFixture());
    const base = root();
    const foreign = join(base, "foreign.sqlite");
    const database = new Database(foreign); database.run("CREATE TABLE foreign_data (value TEXT)"); database.close();
    const linkedRoot = join(base, "linked-root");
    mkdirSync(linkedRoot);
    let linked = true;
    try { symlinkSync(foreign, join(linkedRoot, ".catalog-write.sqlite"), "file"); }
    catch (error) {
      if ((error as { code?: string }).code !== "EPERM") throw error;
      linked = false;
    }
    if (linked) {
      expect(new CompilerArtifactCatalog({ root: linkedRoot, generateId: () => "w".repeat(24) }).savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
      expect(existsSync(join(linkedRoot, "prepared"))).toBe(false);
      const foreignCheck = new Database(foreign, { readonly: true });
      expect(foreignCheck.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalog_policy'").get()).toBeNull();
      foreignCheck.close();
    } else {
      // This Windows runner disallows file symlink creation. Exercise the same
      // pre-open rejection seam without opening a foreign connection.
      const coordinator = new CompilerArtifactCatalogCoordinator(linkedRoot, "test", 1, 1, {
        pathOps: { kind: (path) => path.endsWith(".catalog-write.sqlite") ? "unsafe" : "missing" },
        connectionFactory: () => { throw new Error("foreign link must be rejected before open"); },
      });
      expect(() => coordinator.initializePolicy()).toThrow("regular non-link");
    }

    const directoryRoot = join(base, "directory-root");
    mkdirSync(directoryRoot); mkdirSync(join(directoryRoot, ".catalog-write.sqlite"));
    expect(new CompilerArtifactCatalog({ root: directoryRoot, generateId: () => "x".repeat(24) }).savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
    expect(existsSync(join(directoryRoot, "prepared"))).toBe(false);
  });

  it("rejects a leaf junction and accepts an explicitly unsupported directory fsync", async () => {
    const base = root();
    const target = join(base, "real");
    const junction = join(base, "catalog-junction");
    mkdirSync(target);
    const fixture = await import("./helpers/compiled-module-http-fixture").then(({ compiledModuleHttpFixture }) => compiledModuleHttpFixture());
    try {
      symlinkSync(target, junction, "junction");
      expect(new CompilerArtifactCatalog({ root: junction, generateId: () => "q".repeat(24) }).savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
      expect(existsSync(join(junction, ".catalog-write.sqlite"))).toBe(false);
    } catch (error) {
      // This runner denies a real root junction. The separate foreign-
      // database-link test probes file-link behavior; this branch cannot claim
      // real OS root-link coverage, so use the catalog's file-operation seam
      // to prove root rejection happens before SQLite coordination or catalog
      // read/open/unlink operations.
      expect((error as { code?: string }).code).toBe("EPERM");
      mkdirSync(junction);
      let coordinatorCalls = 0;
      let opens = 0;
      let reads = 0;
      let removals = 0;
      const guarded = new CompilerArtifactCatalog({
        root: junction,
        generateId: () => "q".repeat(24),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          isSafeDirectory: (path) => path === junction ? false : compilerArtifactCatalogNodeFileOps.isSafeDirectory(path),
          open(path) { opens++; throw new Error(`unsafe root reached catalog open: ${path}`); },
          read(path) { reads++; throw new Error(`unsafe root reached catalog read: ${path}`); },
          remove(path) { removals++; throw new Error(`unsafe root reached catalog unlink: ${path}`); },
        },
        coordinatorFactory: () => {
          coordinatorCalls++;
          throw new Error("unsafe root reached SQLite open");
        },
      });
      expect(guarded.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
      expect(coordinatorCalls).toBe(0);
      expect(opens).toBe(0);
      expect(reads).toBe(0);
      expect(removals).toBe(0);
    }

    const catalog = new CompilerArtifactCatalog({
      root: join(base, "directory-fsync-unsupported"),
      generateId: () => "r".repeat(24),
      fileOps: { ...compilerArtifactCatalogNodeFileOps, syncDirectory: () => "unsupported" },
    });
    expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "ok" });
  });
});
