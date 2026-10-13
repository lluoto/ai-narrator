import { existsSync } from "fs";
import { join } from "path";
import { CompiledIntentAdmissionCoordinator } from "../api/compiled-intent-admission";
import { CompiledIntentReplayStore } from "../api/compiled-intent-replay";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { createEnvironmentCompilerAuthenticator, handleRequest } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";

const MARKER = "@@compiled-intent-dual-process-race@@";
const KEEPER_TOKEN = "k".repeat(48);
const WAIT_MS = 15_000;
const OUTPUT_FLOOD_BYTES = 32 * 1024;

type ChildMode = "race" | "flood-stdout" | "flood-stderr";

function emit(value: Record<string, unknown>): void {
  console.log(`${MARKER}${JSON.stringify(value)}`);
}

function stdinLines() {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return async (): Promise<string> => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return line;
      }
      const next = await reader.read();
      if (next.done) throw new Error("dual-process race child stdin closed before a command");
      pending += decoder.decode(next.value, { stream: true });
    }
  };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`dual-process race child timed out waiting for ${label}`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function waitForBarrier(path: string): void {
  const deadline = Date.now() + WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("dual-process race replay barrier timed out");
    Atomics.wait(sleeper, 0, 0, Math.min(remaining, 25));
  }
}

class FirstMissBarrierReplayStore extends CompiledIntentReplayStore {
  private reads = 0;

  constructor(root: string, private readonly barrierPath: string, private readonly label: string) {
    super(root);
  }

  override read(identity: Parameters<CompiledIntentReplayStore["read"]>[0]) {
    const result = super.read(identity);
    this.reads += 1;
    if (this.reads === 1) {
      if (result.status !== "absent") throw new Error("B expected its first real replay read to miss");
      emit({ event: "first-replay-miss", label: this.label });
      // This synchronous boundary is deliberately after the real SQLite read
      // and immediately before resolveCompiledIntentWithReplay calls acquire.
      waitForBarrier(this.barrierPath);
    }
    return result;
  }
}

class ObservedAdmissionCoordinator extends CompiledIntentAdmissionCoordinator {
  constructor(root: string, private readonly label: string) {
    super(root);
  }

  override acquire(binding: Parameters<CompiledIntentAdmissionCoordinator["acquire"]>[0]) {
    emit({ event: "before-real-acquire", label: this.label });
    const result = super.acquire(binding);
    emit({ event: "after-real-acquire", label: this.label, status: result.status });
    return result;
  }
}

async function run(root: string, sessionId: string, label: "A" | "B", barrierPath: string): Promise<void> {
  const command = stdinLines();
  const careers = join(root, "careers");
  const runtimeRoot = join(careers, ".runtime-session-namespace");
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const authenticator = createEnvironmentCompilerAuthenticator({
    COMPILER_OPERATOR_BEARER_TOKEN: "o".repeat(48),
    COMPILER_KEEPER_BEARER_TOKEN: KEEPER_TOKEN,
  });
  const runtime = {
    registry: new Map(),
    sessionNamespace: new SessionNamespaceCoordinator(runtimeRoot),
    compiledIntentAdmission: label === "B"
      ? new ObservedAdmissionCoordinator(runtimeRoot, label)
      : new CompiledIntentAdmissionCoordinator(runtimeRoot),
    compiledIntentReplay: label === "B"
      ? new FirstMissBarrierReplayStore(runtimeRoot, barrierPath, label)
      : new CompiledIntentReplayStore(runtimeRoot),
  };
  let providerCalls = 0;
  const llm = {
    async chat() {
      providerCalls += 1;
      emit({ event: "provider-entered", label, providerCalls });
      if (label === "A") {
        if (await within(command(), "A provider release") !== "settle") {
          throw new Error("A received an invalid provider release command");
        }
      }
      return '{"kind":"no_match"}';
    },
  };

  emit({ event: "ready", label });
  if (await within(command(), `${label} start`) !== "start") throw new Error(`${label} received an invalid start command`);
  const response = await handleRequest(new Request(`https://example.test/api/sessions/${sessionId}/compiled/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
    body: JSON.stringify({ input: "two-process replay race", pcId: "p1", expectedGeneration: 0 }),
  }), catalog, snapshots, { careerRoot: careers }, { llm, isLlmEnabled: () => true }, {}, authenticator,
  undefined, undefined, undefined, undefined, runtime);
  emit({ event: "result", label, status: response.status, body: await response.json(), providerCalls });
}

/** Test-only hostile-child seam for proving parent capture limits terminate its own handle. */
async function floodOutput(mode: Exclude<ChildMode, "race">): Promise<never> {
  const payload = "x".repeat(OUTPUT_FLOOD_BYTES);
  if (mode === "flood-stdout") await Bun.write(Bun.stdout, payload);
  else await Bun.write(Bun.stderr, payload);
  // A child that keeps running after filling a pipe must still be handled by
  // the parent's bounded capture path rather than its ordinary test timeout.
  return new Promise<never>(() => undefined);
}

if (import.meta.main) {
  const [root, sessionId, rawLabel, barrierPath, rawMode = "race"] = process.argv.slice(2);
  try {
    if (rawMode !== "race" && rawMode !== "flood-stdout" && rawMode !== "flood-stderr") {
      throw new Error("dual-process race child received an invalid mode");
    }
    if (rawMode !== "race") {
      await floodOutput(rawMode);
      throw new Error("dual-process race flood child unexpectedly returned");
    }
    if (!root || !sessionId || (rawLabel !== "A" && rawLabel !== "B") || !barrierPath) {
      throw new Error("dual-process race child requires root, session id, A|B label, and barrier path");
    }
    await run(root, sessionId, rawLabel, barrierPath);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
