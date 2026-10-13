import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { createEnvironmentCompilerAuthenticator, handleRequest } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";

const child = join(import.meta.dir, "compiled-intent-dual-process-race-child.ts");
const MARKER = "@@compiled-intent-dual-process-race@@";
const KEEPER_TOKEN = "k".repeat(48);
const WAIT_MS = 15_000;
const MAX_CAPTURED_BYTES_PER_STREAM = 16 * 1024;

type ChildEvent = Record<string, unknown> & { event: string; label: "A" | "B" };
type ChildMode = "race" | "flood-stdout" | "flood-stderr";

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function spawnChild(root: string, sessionId: string, label: "A" | "B", barrierPath: string, mode: ChildMode = "race") {
  const processHandle = Bun.spawn([process.execPath, child, root, sessionId, label, barrierPath, mode], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const events: ChildEvent[] = [];
  let wake: (() => void) | undefined;
  let stdout = "";
  let stderr = "";
  let pending = "";
  let stdinClosed = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let captureFailure: Error | undefined;
  let terminationRequested = false;
  const terminateOnlyThisChild = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    try { processHandle.kill(); } catch { /* an exited child needs no further action */ }
  };
  const failClosedForOutput = (stream: "stdout" | "stderr", receivedBytes: number) => {
    if (captureFailure) return;
    captureFailure = new Error(`dual-process race child ${label} ${stream} exceeded ${MAX_CAPTURED_BYTES_PER_STREAM} captured bytes (${receivedBytes})`);
    terminateOnlyThisChild();
    wake?.();
    wake = undefined;
  };
  const capture = (stream: "stdout" | "stderr", chunk: Uint8Array): boolean => {
    const receivedBytes = stream === "stdout" ? stdoutBytes + chunk.byteLength : stderrBytes + chunk.byteLength;
    if (receivedBytes > MAX_CAPTURED_BYTES_PER_STREAM) {
      failClosedForOutput(stream, receivedBytes);
      return false;
    }
    if (stream === "stdout") stdoutBytes = receivedBytes;
    else stderrBytes = receivedBytes;
    return true;
  };
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of processHandle.stdout) {
      if (!capture("stdout", chunk)) continue;
      const text = decoder.decode(chunk, { stream: true });
      stdout += text;
      pending += text;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith(MARKER)) continue;
        events.push(JSON.parse(line.slice(MARKER.length)) as ChildEvent);
        wake?.();
        wake = undefined;
      }
    }
    if (!captureFailure) stdout += decoder.decode();
  })();
  const stderrDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of processHandle.stderr) {
      if (!capture("stderr", chunk)) continue;
      stderr += decoder.decode(chunk, { stream: true });
    }
    if (!captureFailure) stderr += decoder.decode();
  })();
  const next = async (): Promise<ChildEvent> => {
    if (captureFailure) throw captureFailure;
    while (!events.length) {
      const state = await Promise.race([
        new Promise<"event">((resolve) => { wake = () => resolve("event"); }),
        processHandle.exited.then(() => "exit" as const),
      ]);
      if (captureFailure) throw captureFailure;
      if (state === "exit" && !events.length) {
        await Promise.all([stdoutDrain, stderrDrain]);
        if (captureFailure) throw captureFailure;
        throw new Error(`dual-process race child ${label} exited before an event:\n${stdout}\n${stderr}`);
      }
    }
    return events.shift()!;
  };
  const send = async (command: "start" | "settle", close = false) => {
    if (stdinClosed) return;
    const stdin = processHandle.stdin;
    if (!stdin || typeof stdin === "number") throw new Error(`dual-process race child ${label} stdin is unavailable`);
    stdin.write(`${command}\n`);
    await stdin.flush();
    if (close) {
      stdinClosed = true;
      stdin.end();
    }
  };
  return {
    next: () => within(next(), `dual-process race child ${label} event`),
    send,
    async finish() {
      const code = await within(processHandle.exited, `dual-process race child ${label} exit`);
      await within(Promise.all([stdoutDrain, stderrDrain]), `dual-process race child ${label} drain`);
      if (captureFailure) throw captureFailure;
      if (code !== 0) throw new Error(`dual-process race child ${label} failed (${code}):\n${stdout}\n${stderr}`);
    },
    async dispose() {
      try { await send("settle"); } catch { /* the child can already be gone */ }
      try {
        const stdin = processHandle.stdin;
        if (stdin && typeof stdin !== "number") {
          stdinClosed = true;
          stdin.end();
        }
      } catch { /* cleanup continues with this test's child only */ }
      try { await within(processHandle.exited, `dual-process race child ${label} cleanup`); }
      catch { terminateOnlyThisChild(); }
      try { await Promise.all([stdoutDrain, stderrDrain]); } catch { /* the original failure is authoritative */ }
    },
  };
}

async function createPersistedCompiledSession(root: string): Promise<string> {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const stored = saveTrustedFixtureBundle(catalog, fixture);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const authenticator = createEnvironmentCompilerAuthenticator({
    COMPILER_OPERATOR_BEARER_TOKEN: "o".repeat(48),
    COMPILER_KEEPER_BEARER_TOKEN: KEEPER_TOKEN,
  });
  const response = await handleRequest(new Request("https://example.test/api/sessions/compiled", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
    body: JSON.stringify({ bundleId: stored.id, archetype: "investigator", characterName: "Process race" }),
  }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticator,
  undefined, undefined, undefined, undefined, { registry: new Map() });
  if (response.status !== 201) throw new Error(`compiled race fixture creation failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { sessionId?: string };
  if (!payload.sessionId) throw new Error("compiled race fixture did not return a session ID");
  return payload.sessionId;
}

describe("compiled intent real two-process replay race", () => {
  it("fails closed on bounded stdout and stderr capture overflow without waiting for the child timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-dual-process-output-cap-"));
    try {
      for (const mode of ["flood-stdout", "flood-stderr"] as const) {
        const flooded = spawnChild(root, "unused", "A", join(root, "unused-barrier"), mode);
        const stream = mode === "flood-stdout" ? "stdout" : "stderr";
        try {
          await expect(flooded.next()).rejects.toThrow(`child A ${stream} exceeded ${MAX_CAPTURED_BYTES_PER_STREAM} captured bytes`);
          // finish waits for processHandle.exited, so this proves overflow
          // termination did not leave this deliberately non-settling child hung.
          await expect(flooded.finish()).rejects.toThrow(`child A ${stream} exceeded ${MAX_CAPTURED_BYTES_PER_STREAM} captured bytes`);
        } finally {
          await flooded.dispose();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("replays A's settled no_match after B's real initial miss and later real acquire without a B provider call", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-dual-process-race-"));
    const barrierPath = join(root, "release-b-after-a-settles");
    let a: ReturnType<typeof spawnChild> | undefined;
    let b: ReturnType<typeof spawnChild> | undefined;
    try {
      const sessionId = await createPersistedCompiledSession(root);
      a = spawnChild(root, sessionId, "A", barrierPath);
      b = spawnChild(root, sessionId, "B", barrierPath);
      expect(await a.next()).toMatchObject({ event: "ready", label: "A" });
      expect(await b.next()).toMatchObject({ event: "ready", label: "B" });

      await a.send("start");
      expect(await a.next()).toMatchObject({ event: "provider-entered", label: "A", providerCalls: 1 });

      await b.send("start", true);
      // B has called the real durable replay store, observed absence, and is
      // synchronously paused immediately before its real coordinator acquire.
      expect(await b.next()).toMatchObject({ event: "first-replay-miss", label: "B" });

      await a.send("settle", true);
      const settledA = await a.next();
      expect(settledA).toMatchObject({
        event: "result", label: "A", status: 200, body: { status: "no_match", generation: 0 }, providerCalls: 1,
      });

      // A's HTTP result is emitted only after its replay save and lease
      // release. Releasing this barrier now makes B execute super.acquire(),
      // followed by the production second replay read.
      writeFileSync(barrierPath, "release");
      expect(await b.next()).toMatchObject({ event: "before-real-acquire", label: "B" });
      expect(await b.next()).toMatchObject({ event: "after-real-acquire", label: "B", status: "acquired" });
      expect(await b.next()).toMatchObject({
        event: "result", label: "B", status: 200, body: { status: "no_match", generation: 0 }, providerCalls: 0,
      });

      await Promise.all([a.finish(), b.finish()]);
    } finally {
      // Unblock B even when an assertion fails before the normal release.
      try { writeFileSync(barrierPath, "release"); } catch { /* root setup can fail first */ }
      await Promise.all([a?.dispose(), b?.dispose()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
