import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const child = join(import.meta.dir, "legacy-character-routes-retired-child.ts");
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "legacy-character-routes-retired-"));
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
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith("@@legacy-character-routes-retired@@"));
  if (code !== 0 || !line) throw new Error(`legacy character route child failed (exit ${code}): ${stdout}\n${stderr}`);
  return JSON.parse(line.slice("@@legacy-character-routes-retired@@".length)) as Record<string, any>;
}

function frontendSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? frontendSources(path) : [path];
  });
}

describe("retired global character-card routes", () => {
  it("does not route anonymous or authenticated legacy requests, consume POST bodies, or create global storage", async () => {
    expect((await run(root())).legacy).toEqual({
      anonymousGet: 404,
      authenticatedGet: 404,
      anonymousPost: 404,
      authenticatedPost: 404,
      anonymousPostPulls: 0,
      authenticatedPostPulls: 0,
      characterDirExists: false,
    });
  }, 20_000);

  it("has no frontend dependency on the retired endpoint and retains the session-bound character path", () => {
    const frontend = frontendSources(join(import.meta.dir, "../../frontend/src"))
      .map((path) => readFileSync(path, "utf-8"))
      .join("\n");
    expect(frontend).not.toContain("/api/characters");
    expect(frontend).toContain("/sessions/${sessionId}/character");
  });

});
