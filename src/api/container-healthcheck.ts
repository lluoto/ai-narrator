import { parseServerPort } from "./server-runtime-config";

const REQUEST_TIMEOUT_MS = 4_000;

function isHealthyBody(value: unknown): value is { status: "ok" } {
  return typeof value === "object" && value !== null
    && "status" in value && (value as { status?: unknown }).status === "ok";
}

async function main(): Promise<void> {
  process.exitCode = 1;
  const port = parseServerPort(process.env.PORT);
  if (port === undefined) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api`, { signal: controller.signal });
    if (!response.ok) return;
    if (!isHealthyBody(await response.json())) return;
    process.exitCode = 0;
  } catch {
    // A liveness probe deliberately fails closed without disclosing runtime state.
  } finally {
    clearTimeout(timeout);
  }
}

void main();
