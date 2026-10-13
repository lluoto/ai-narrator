import { it } from "bun:test";

const NATIVE_FETCH_CHILD_ENV = "AITRPG_NATIVE_FETCH_CHILD";
const NATIVE_FETCH_CHILD_TIMEOUT_ENV = "AITRPG_NATIVE_FETCH_CHILD_TIMEOUT_MS";
const NATIVE_FETCH_PROTOCOL_PREFIX = "__AITRPG_NATIVE_FETCH_PHASE__";

/*
 * The outer test runs under preflight's finite 30s per-test ceiling.  A
 * freshly spawned Bun process needs a little time before its selected test
 * begins, so giving both processes an independent 30s window is not a valid
 * contract: the parent can time out while its child is still within budget.
 *
 * Keep one bounded envelope instead.  The child gets 25s for the actual test;
 * its startup and final exit have the remaining five seconds.  The loopback
 * proofs normally complete in well under two seconds, while a real hang still
 * has a deterministic owner and deadline.
 */
const NATIVE_FETCH_PARENT_TIMEOUT_MS = 30_000;
// Leave a full second for the parent test runner to observe the child exit and
// turn its captured output into a useful failure before preflight's 30s cap.
const NATIVE_FETCH_WATCHDOG_TIMEOUT_MS = 29_000;
const NATIVE_FETCH_CHILD_STARTUP_TIMEOUT_MS = 5_000;
const NATIVE_FETCH_CHILD_TEST_TIMEOUT_MS = 24_000;
const NATIVE_FETCH_CHILD_RUNNER_TIMEOUT_MS = 25_000;
const NATIVE_FETCH_CHILD_EXIT_TIMEOUT_MS = 1_000;
const NATIVE_FETCH_CUSTOM_CLEANUP_RESERVE_MS = 1_000;
const NATIVE_FETCH_MINIMUM_CUSTOM_PARENT_TIMEOUT_MS =
  NATIVE_FETCH_CUSTOM_CLEANUP_RESERVE_MS * 2;

type NativeFetchIsolationPhase = "spawned" | "ready" | "result:ok" | "result:error";

interface NativeFetchIsolationBudget {
  parentTimeoutMs: number;
  watchdogTimeoutMs: number;
  startupTimeoutMs: number;
  childTestTimeoutMs: number;
  childRunnerTimeoutMs: number;
  exitTimeoutMs: number;
}

const DEFAULT_NATIVE_FETCH_ISOLATION_BUDGET: NativeFetchIsolationBudget = {
  parentTimeoutMs: NATIVE_FETCH_PARENT_TIMEOUT_MS,
  watchdogTimeoutMs: NATIVE_FETCH_WATCHDOG_TIMEOUT_MS,
  startupTimeoutMs: NATIVE_FETCH_CHILD_STARTUP_TIMEOUT_MS,
  childTestTimeoutMs: NATIVE_FETCH_CHILD_TEST_TIMEOUT_MS,
  childRunnerTimeoutMs: NATIVE_FETCH_CHILD_RUNNER_TIMEOUT_MS,
  exitTimeoutMs: NATIVE_FETCH_CHILD_EXIT_TIMEOUT_MS,
};

function exactTestNamePattern(suite: string, name: string): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bun matches its flattened internal test name; the reporter adds ` > `.
  return `^${escape(suite)} ${escape(name)}$`;
}

export function isNativeFetchIsolationChild(): boolean {
  return process.env[NATIVE_FETCH_CHILD_ENV] === "1";
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function childTestTimeoutMs(): number {
  return positiveInteger(process.env[NATIVE_FETCH_CHILD_TIMEOUT_ENV])
    ?? NATIVE_FETCH_CHILD_TEST_TIMEOUT_MS;
}

function emitPhase(phase: Exclude<NativeFetchIsolationPhase, "spawned">): void {
  // This is a parent/child test protocol, not a product log.  A raw marker is
  // deliberate: Bun's reporter may buffer its own output, while stdout keeps
  // the child lifecycle observable to the parent watchdog.
  process.stdout.write(`${NATIVE_FETCH_PROTOCOL_PREFIX}${phase}\n`);
}

function budgetForRequestedTimeout(timeout: number | undefined): NativeFetchIsolationBudget {
  if (timeout === undefined) return DEFAULT_NATIVE_FETCH_ISOLATION_BUDGET;
  if (!Number.isSafeInteger(timeout) || timeout < NATIVE_FETCH_MINIMUM_CUSTOM_PARENT_TIMEOUT_MS) {
    throw new RangeError(
      `isolated native-fetch timeout must be a safe integer of at least ${NATIVE_FETCH_MINIMUM_CUSTOM_PARENT_TIMEOUT_MS}ms`,
    );
  }
  const watchdogTimeoutMs = timeout - NATIVE_FETCH_CUSTOM_CLEANUP_RESERVE_MS;
  // A caller that supplied a narrower test timeout owns the whole operation.
  // Its child must nevertheless finish strictly before the outer Bun test so
  // the helper can drain output and report which phase stalled.
  return {
    parentTimeoutMs: timeout,
    watchdogTimeoutMs,
    startupTimeoutMs: watchdogTimeoutMs,
    childTestTimeoutMs: watchdogTimeoutMs,
    childRunnerTimeoutMs: watchdogTimeoutMs,
    exitTimeoutMs: Math.min(NATIVE_FETCH_CHILD_EXIT_TIMEOUT_MS, watchdogTimeoutMs),
  };
}

async function readChildOutput(
  stream: ReadableStream<Uint8Array>,
  onPhase: (phase: Exclude<NativeFetchIsolationPhase, "spawned">) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let incompleteLine = "";
  const consume = (text: string) => {
    output += text;
    const lines = `${incompleteLine}${text}`.split(/\r?\n/);
    incompleteLine = lines.pop() ?? "";
    for (const line of lines) {
      const phase = line.startsWith(NATIVE_FETCH_PROTOCOL_PREFIX)
        ? line.slice(NATIVE_FETCH_PROTOCOL_PREFIX.length) as Exclude<NativeFetchIsolationPhase, "spawned">
        : undefined;
      if (phase === "ready" || phase === "result:ok" || phase === "result:error") onPhase(phase);
    }
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      consume(decoder.decode(next.value, { stream: true }));
    }
    consume(decoder.decode());
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function runNativeFetchIsolationChild(
  testFile: string,
  suite: string,
  name: string,
  budget: NativeFetchIsolationBudget,
  extraEnvironment: Record<string, string | undefined> = {},
): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "test",
    "--timeout",
    String(budget.childRunnerTimeoutMs),
    "--test-name-pattern",
    exactTestNamePattern(suite, name),
    testFile,
  ], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      [NATIVE_FETCH_CHILD_ENV]: "1",
      // These loopback-listener proofs do not need a provider. Preserve an
      // explicit caller override, while keeping the child offline by default.
      LLM_DISABLED: process.env.LLM_DISABLED ?? "true",
      [NATIVE_FETCH_CHILD_TIMEOUT_ENV]: String(budget.childTestTimeoutMs),
      ...extraEnvironment,
    },
  });
  let phase: NativeFetchIsolationPhase = "spawned";
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const watchdogDeadline = performance.now() + budget.watchdogTimeoutMs;
  const armTimeout = (timeoutMs: number) => {
    clearTimeout(timeout);
    // Phase progress may choose a stricter deadline, but it never extends the
    // single parent-owned budget.  This keeps startup + test + exit bounded
    // below the enclosing preflight runner timeout.
    const remaining = watchdogDeadline - performance.now();
    timeout = setTimeout(() => {
      timedOut = true;
      // This is the exact child we created above.  We never signal by PID or
      // touch a process we did not spawn; closing it also releases its
      // ephemeral loopback listener if its own finally block cannot run.
      child.kill();
    }, Math.max(0, Math.min(timeoutMs, remaining)));
  };
  armTimeout(budget.startupTimeoutMs);
  const stdout = readChildOutput(child.stdout, (nextPhase) => {
    phase = nextPhase;
    if (nextPhase === "ready") armTimeout(budget.childTestTimeoutMs);
    else armTimeout(budget.exitTimeoutMs);
  });
  const stderr = new Response(child.stderr).text();
  try {
    const exitCode = await child.exited;
    const [output, errors] = await Promise.all([stdout, stderr]);
    if (timedOut) {
      throw new Error(`isolated native-fetch test exceeded its bounded ${phase} phase and was terminated: ${testFile} > ${name}\n--- stdout ---\n${output}\n--- stderr ---\n${errors}`);
    }
    if (exitCode !== 0) {
      throw new Error(`isolated native-fetch test failed (${exitCode}, phase ${phase}): ${testFile} > ${name}\n--- stdout ---\n${output}\n--- stderr ---\n${errors}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Test-only seam for proving the watchdog kills its own stalled child. */
export const nativeFetchIsolationTestInternals = {
  budgetForRequestedTimeout,
  runNativeFetchIsolationChild,
};

/**
 * Keep the parent suite's original test name and count, but execute the one
 * listener proof in a fresh Bun process where no sibling can replace fetch.
 */
export function isolatedNativeFetchIt(testFile: string, suite: string): (
  name: string,
  callback: () => void | Promise<void>,
  timeout?: number,
) => void {
  return (name, callback, timeout) => {
    if (isNativeFetchIsolationChild()) {
      it(name, async () => {
        emitPhase("ready");
        try {
          await callback();
          emitPhase("result:ok");
        } catch (error) {
          emitPhase("result:error");
          throw error;
        }
      }, childTestTimeoutMs());
      return;
    }
    const budget = budgetForRequestedTimeout(timeout);
    it(name, () => runNativeFetchIsolationChild(testFile, suite, name, budget), budget.parentTimeoutMs);
  };
}
