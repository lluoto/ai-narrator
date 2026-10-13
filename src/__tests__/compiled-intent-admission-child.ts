import { CompiledIntentAdmissionCoordinator } from "../api/compiled-intent-admission";

const MARKER = "@@compiled-intent-admission@@";

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
      if (next.done) throw new Error("compiled intent admission child stdin closed before signal");
      pending += decoder.decode(next.value, { stream: true });
    }
  };
}

async function race(root: string, label: string): Promise<void> {
  const next = stdinLines();
  const admission = new CompiledIntentAdmissionCoordinator(root);
  emit({ event: "ready", label });
  if (await next() !== "go") throw new Error("compiled intent admission child received invalid start signal");
  const held = admission.acquire({ sessionId: "compiled-intent-cross-process-session", expectedGeneration: 0, input: `opaque-summary-${label}` });
  if (held.status !== "acquired") {
    emit({ event: "result", label, status: held.code === "ORDINARY_ACTION_BUSY" ? 429 : 503, providerCalls: 0, retryAfter: held.retryAfterSeconds });
    if (await next() !== "release") throw new Error("compiled intent admission loser received invalid release signal");
    return;
  }
  // This is deliberately the process-local provider seam. Exactly one child
  // may reach it before either is allowed to settle its durable lease.
  emit({ event: "provider-entered", label, providerCalls: 1 });
  if (await next() !== "release") throw new Error("compiled intent admission winner received invalid release signal");
  held.release();
  emit({ event: "result", label, status: 200, providerCalls: 1 });
}

if (import.meta.main) {
  const [root, label] = process.argv.slice(2);
  try {
    if (!root || !label) throw new Error("compiled intent admission child requires root and label");
    await race(root, label);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
