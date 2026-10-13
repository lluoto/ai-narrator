import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const child = join(import.meta.dir, "ordinary-session-process-child.ts");
const crashChild = join(import.meta.dir, "ordinary-session-crash-child.ts");
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ordinary-process-restart-"));
  roots.add(value);
  return value;
}

async function run(phase: "seed" | "resume" | "seed-cold" | "resume-cold", rootPath: string, sessionId?: string): Promise<Record<string, unknown>> {
  const childProcess = Bun.spawn([process.execPath, child, phase, rootPath, ...(sessionId ? [sessionId] : [])], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LLM_DISABLED: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
    childProcess.exited,
  ]);
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith("@@ordinary-process@@"));
  if (code !== 0 || !line) throw new Error(`ordinary process ${phase} failed (exit ${code}): ${stdout}\n${stderr}`);
  return JSON.parse(line.slice("@@ordinary-process@@".length)) as Record<string, unknown>;
}

async function readCrashStage(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("ordinary crash child exited before its requested stage");
    pending += decoder.decode(next.value, { stream: true });
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("@@ordinary-crash@@")) return JSON.parse(line.slice("@@ordinary-crash@@".length)) as Record<string, unknown>;
  }
}

async function crashAt(rootPath: string, phase: "crash-body" | "crash-pointer"): Promise<{ process: ReturnType<typeof Bun.spawn>; stage: Record<string, unknown> }> {
  const childProcess = Bun.spawn([process.execPath, crashChild, phase, rootPath], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLM_DISABLED: "1" },
  });
  if (!childProcess.stdout || typeof childProcess.stdout === "number") throw new Error("ordinary crash child stdout is unavailable");
  return { process: childProcess, stage: await readCrashStage(childProcess.stdout) };
}

async function recoverCrash(rootPath: string, phase: "recover-body" | "recover-pointer"): Promise<Record<string, unknown>> {
  const childProcess = Bun.spawn([process.execPath, crashChild, phase, rootPath], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, LLM_DISABLED: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited]);
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith("@@ordinary-crash@@"));
  if (code !== 0 || !line) throw new Error(`ordinary crash recovery ${phase} failed (exit ${code}): ${stdout}\n${stderr}`);
  return JSON.parse(line.slice("@@ordinary-crash@@".length)) as Record<string, unknown>;
}

describe("ordinary durable HTTP fresh-process recovery", () => {
  test("recovers quota and authority after a real child dies with dirty manifest and first body artifact but no pointer", async () => {
    const storageRoot = root(); const crashed = await crashAt(storageRoot, "crash-body");
    expect(crashed.stage).toEqual({ event: "stage", phase: "crash-body", stage: "first-artifact-persisted" });
    crashed.process.kill(); await crashed.process.exited;
    expect(await recoverCrash(storageRoot, "recover-body")).toEqual({
      event: "recovered", phase: "recover-body",
      absent: { status: "refused", code: "ORDINARY_SNAPSHOT_NOT_FOUND" },
      saved: { status: "ok", generation: 0 },
      authorityAfter: { status: "refused", code: "ORDINARY_SNAPSHOT_NOT_FOUND" },
      nextAfter: { status: "ok", generation: 0 },
    });
  }, 20_000);

  test("recovers durable pointer authority and quota after a real child dies before final clean manifest", async () => {
    const storageRoot = root(); const crashed = await crashAt(storageRoot, "crash-pointer");
    expect(crashed.stage).toEqual({ event: "stage", phase: "crash-pointer", stage: "pointer-durable-before-clean" });
    crashed.process.kill(); await crashed.process.exited;
    expect(await recoverCrash(storageRoot, "recover-pointer")).toEqual({
      event: "recovered", phase: "recover-pointer",
      authorityBefore: { status: "ok", generation: 0 },
      exact: { status: "ok", generation: 0 },
      blocked: { status: "refused", code: "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED" },
      authorityAfter: { status: "ok", generation: 0 },
    });
  }, 20_000);

  test("recovers an action in a fresh Bun process and replays its exact receipt without execution or broadcast", async () => {
    const storageRoot = root();
    const first = await run("seed", storageRoot);
    const sessionId = first.sessionId;
    expect(first).toMatchObject({ phase: "seed", sessionId: expect.any(String), actionCalls: 1, recoveryCalls: 0, receipt: { ordinaryGeneration: 1 } });
    expect(typeof sessionId).toBe("string");

    const second = await run("resume", storageRoot, sessionId as string);
    expect(second).toMatchObject({
      phase: "resume",
      state: { status: 200, body: { ordinaryGeneration: 1 } },
      // Resume constructs once for g1, then the committed g2 derives through
      // the same trusted pristine factory for its staging candidate and live
      // replacement.
      recoveryCalls: 3,
      duplicate: { status: 200, disposition: "duplicate", actionCalls: 0, broadcasts: 0 },
      conflicting: { status: 409, body: { code: "ordinary_action_id_conflict" }, actionCalls: 0, broadcasts: 0 },
      continued: { status: 200, body: { ordinaryGeneration: 2 }, actionCalls: 1, broadcasts: 1 },
    });
    expect((second.duplicate as { body: unknown }).body).toEqual(first.receipt);
  }, 30_000);

  test("replays a cold receipt beyond the hot window in a separate Bun process", async () => {
    const storageRoot = root();
    const first = await run("seed-cold", storageRoot);
    const sessionId = first.sessionId as string;
    expect(first).toMatchObject({ phase: "seed-cold", sessionId: expect.any(String), actionCalls: 1, finalGeneration: 130, namespaceGeneration: 130, receipt: { ordinaryGeneration: 1 } });
    const second = await run("resume-cold", storageRoot, sessionId);
    expect(second).toMatchObject({
      // The committed successor has the same source/replacement construction
      // contract regardless of whether its predecessor receipt is cold.
      phase: "resume-cold", state: { status: 200, body: { ordinaryGeneration: 130 } }, recoveryCalls: 3,
      duplicate: { status: 200, disposition: "duplicate", actionCalls: 0, broadcasts: 0 },
      conflicting: { status: 409, body: { code: "ordinary_action_id_conflict" }, actionCalls: 0, broadcasts: 0 },
      continued: { status: 200, body: { ordinaryGeneration: 131 }, actionCalls: 1, broadcasts: 1 },
    });
    expect((second.duplicate as { body: unknown }).body).toEqual(first.receipt);
  }, 90_000);
});
