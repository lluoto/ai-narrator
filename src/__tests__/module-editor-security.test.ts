import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const child = join(import.meta.dir, "module-editor-security-child.ts");
const containmentChild = join(import.meta.dir, "module-editor-containment-child.ts");
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "module-editor-security-"));
  roots.add(value);
  return value;
}

async function run(rootPath: string): Promise<Record<string, any>> {
  const childProcess = Bun.spawn([process.execPath, child], {
    cwd: rootPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LLM_DISABLED: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
    childProcess.exited,
  ]);
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith("@@module-editor-security@@"));
  if (code !== 0 || !line) throw new Error(`module-editor security child failed (exit ${code}): ${stdout}\n${stderr}`);
  return JSON.parse(line.slice("@@module-editor-security@@".length)) as Record<string, any>;
}

async function runContainment(rootPath: string): Promise<Record<string, unknown>> {
  const childProcess = Bun.spawn([process.execPath, containmentChild], {
    cwd: rootPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LLM_DISABLED: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
    childProcess.exited,
  ]);
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith("@@module-editor-containment@@"));
  if (code !== 0 || !line) throw new Error(`module-editor containment child failed (exit ${code}): ${stdout}\n${stderr}`);
  return JSON.parse(line.slice("@@module-editor-containment@@".length)) as Record<string, unknown>;
}

describe("legacy module editor HTTP authority and path containment", () => {
  it("authenticates every CRUD route before body consumption or module filesystem access", async () => {
    const result = await run(root());
    expect(result.anonymous).toEqual({
      list: 401,
      get: 401,
      post: 401,
      delete: 401,
      postPulls: 0,
      deletePulls: 0,
      modulesDirExists: false,
      escapedFileExists: false,
    });
  }, 20_000);

  it("uses a single safe module-ID contract for request parsing and module file operations", async () => {
    const result = await run(root());
    expect(result.unsafe).toEqual({
      post: 400,
      encodedGet: 404,
      encodedDelete: 404,
      directSaveRefused: true,
      directDeleteRefused: true,
      directLoadRefused: true,
      allUnsafeIdsRefused: true,
      escapedFileExists: false,
    });
  }, 20_000);

  it("rejects a hostile resolved storage target even when the public ID itself is safe", async () => {
    expect(await runContainment(root())).toEqual({ refused: true, escapedFileExists: false });
  }, 20_000);

  it("allows no caller-declared role and rejects keeper or unavailable authority before module access", async () => {
    const result = await run(root());
    expect(result.authority).toEqual({
      keeperList: 403,
      keeperPost: 403,
      keeperPostPulls: 0,
      keeperDelete: 403,
      unavailableList: 503,
      forgedHeader: 401,
      forgedPostPulls: 0,
    });
  }, 20_000);

  it("keeps the existing editor's legal POST, list, GET, PUT, and DELETE flow", async () => {
    const result = await run(root());
    expect(result.uiCrud).toEqual({
      saved: 200,
      listed: 200,
      listedBody: {
        modules: [{ id: "ui_module-2026", name: "Initial UI module", description: "A module-editor contract fixture.", difficulty: "medium" }],
      },
      loaded: 200,
      loadedBody: {
        module: {
          id: "ui_module-2026", name: "Initial UI module", version: "1.0", description: "A module-editor contract fixture.", difficulty: "medium", activation: { type: "manual", condition: "start" },
        },
      },
      updated: 200,
      updatedLoaded: 200,
      updatedLoadedBody: {
        module: {
          id: "ui_module-2026", name: "Updated UI module", version: "1.0", description: "A module-editor contract fixture.", difficulty: "medium", activation: { type: "manual", condition: "start" },
        },
      },
      removed: 200,
      missing: 404,
    });
  }, 20_000);
});
