import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const healthcheckEntry = resolve(import.meta.dir, "..", "api", "container-healthcheck.ts");

type HealthcheckResult = { code: number; stdout: string; stderr: string };

async function runHealthcheck(port: string): Promise<HealthcheckResult> {
  const child = Bun.spawn([process.execPath, healthcheckEntry], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: port },
  });
  const completion = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("container healthcheck did not finish")), 6_000);
  });
  try {
    return await Promise.race([completion, timedOut]);
  } catch (error) {
    try { child.kill(); } catch { /* child may already have exited */ }
    await completion.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startHealthServer(status: number, body: unknown): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(body, { status }),
  });
}

function expectSilent(result: HealthcheckResult): void {
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
}

describe("container liveness healthcheck", () => {
  test("accepts only a healthy /api response", async () => {
    const server = startHealthServer(200, { status: "ok" });
    try {
      const result = await runHealthcheck(String(server.port));
      expect(result.code).toBe(0);
      expectSilent(result);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects a successful HTTP response with a non-ok body", async () => {
    const server = startHealthServer(200, { status: "error" });
    try {
      const result = await runHealthcheck(String(server.port));
      expect(result.code).toBe(1);
      expectSilent(result);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects a non-2xx /api response", async () => {
    const server = startHealthServer(503, { status: "ok" });
    try {
      const result = await runHealthcheck(String(server.port));
      expect(result.code).toBe(1);
      expectSilent(result);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects an invalid PORT without making a request", async () => {
    const result = await runHealthcheck("not-a-port");
    expect(result.code).toBe(1);
    expectSilent(result);
  });

  test("fails closed when the local listener is unavailable", async () => {
    const server = startHealthServer(200, { status: "ok" });
    const port = String(server.port);
    await server.stop(true);

    const result = await runHealthcheck(port);
    expect(result.code).toBe(1);
    expectSilent(result);
  });
});
