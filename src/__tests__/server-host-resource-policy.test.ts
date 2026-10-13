import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SERVER_HOST_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const serverEntry = resolve(import.meta.dir, "..", "api", "server.ts");
const optionsCapturePreload = resolve(import.meta.dir, "helpers", "server-host-options-capture-preload.ts");
const OPERATOR_TOKEN = "server-host-resource-operator-token".padEnd(40, "o");
const KEEPER_TOKEN = "server-host-resource-keeper-token".padEnd(40, "k");
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "server-host-resource-policy-"));
  mkdirSync(join(value, "src", "rules"), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "..", "rules", "dnd5e.yaml"), join(value, "src", "rules", "dnd5e.yaml"));
  mkdirSync(join(value, "src", "combat"), { recursive: true });
  for (const file of ["dnd-npc.yaml", "coc-npc.yaml", "grail-npc.yaml"]) {
    copyFileSync(resolve(import.meta.dir, "..", "combat", file), join(value, "src", "combat", file));
  }
  roots.add(value);
  return value;
}

async function availablePort(): Promise<number> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const { port } = reservation;
  await reservation.stop(true);
  if (typeof port !== "number") throw new Error("Bun did not report the reserved port");
  return port;
}

function startMain(rootPath: string, port: number, capturePath: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, "--preload", optionsCapturePreload, serverEntry], {
    cwd: rootPath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(port),
      LLM_DISABLED: "1",
      SERVER_HOST_OPTIONS_CAPTURE: capturePath,
      COMPILER_OPERATOR_BEARER_TOKEN: OPERATOR_TOKEN,
      COMPILER_KEEPER_BEARER_TOKEN: KEEPER_TOKEN,
    },
  });
}

async function waitForStartup(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("server main child stdout is unavailable");
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`server main did not report API startup: ${output}`)), 8_000);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timedOut]);
      if (next.done) {
        const stderr = child.stderr && typeof child.stderr !== "number" ? await new Response(child.stderr).text() : "";
        throw new Error(`server main exited before startup (exit ${await child.exited}): ${output}\n${stderr}`);
      }
      output += decoder.decode(next.value, { stream: true });
      if (output.includes("API:")) return;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
}

async function stop(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try { child.kill(); } catch { /* it may already have exited */ }
  await child.exited;
}

describe("server host resource policy", () => {
  test("the real main Bun host owns the 8 MiB request cap and disables contextual error pages", async () => {
    const rootPath = root();
    const capturePath = join(rootPath, "served-options.json");
    const port = await availablePort();
    const child = startMain(rootPath, port, capturePath);
    try {
      await waitForStartup(child);
      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
        maxRequestBodySize: SERVER_HOST_MAX_REQUEST_BODY_BYTES,
        development: false,
      });

      // Bun closes the connection for an over-limit request on this host
      // version instead of serializing a 413. Either behavior is host-level
      // rejection. Without the configured host cap this body reaches the
      // bodyless POST /api route and returns 404, which is intentionally not
      // accepted here.
      let oversizedOutcome: number | "closed";
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(SERVER_HOST_MAX_REQUEST_BODY_BYTES + 1),
        });
        oversizedOutcome = response.status;
      } catch {
        oversizedOutcome = "closed";
      }
      expect(oversizedOutcome === 413 || oversizedOutcome === "closed").toBe(true);

      // The cap is inclusive. Exactly 8 MiB reaches the already-authenticated
      // PDF reader, where this deliberately invalid payload is rejected by the
      // compiler boundary rather than by the Bun host size policy.
      const exactLimitPdf = await fetch(`http://127.0.0.1:${port}/api/compiler/prepare?moduleId=host-cap-exact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          Authorization: `Bearer ${OPERATOR_TOKEN}`,
          "Content-Length": String(SERVER_HOST_MAX_REQUEST_BODY_BYTES),
        },
        body: new Uint8Array(SERVER_HOST_MAX_REQUEST_BODY_BYTES),
      });
      expect(exactLimitPdf.status).toBe(422);

      const health = await fetch(`http://127.0.0.1:${port}/api`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", activeSessions: 0 });
      // Startup owns the empty directory, but the rejected request may not
      // create a locator or session metadata inside it.
      expect(readdirSync(join(rootPath, "data", "sessions"))).toEqual([]);
    } finally {
      await stop(child);
    }
  }, 20_000);
});
