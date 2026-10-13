import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const serverEntry = resolve(import.meta.dir, "..", "api", "server.ts");
const roots = new Set<string>();

function expectSameStaticMetadata(get: Response, head: Response): void {
  expect(head.status).toBe(get.status);
  for (const header of [
    "Content-Type",
    "Cache-Control",
    "Content-Length",
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "X-Frame-Options",
    "Permissions-Policy",
  ]) {
    expect(head.headers.get(header), header).toBe(get.headers.get(header));
  }
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixtureRoot(): { root: string; frontend: string } {
  const root = mkdtempSync(join(tmpdir(), "server-static-delivery-"));
  const frontend = join(root, "frontend-dist");
  roots.add(root);
  mkdirSync(join(root, "src", "rules"), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "..", "rules", "dnd5e.yaml"), join(root, "src", "rules", "dnd5e.yaml"));
  mkdirSync(join(root, "src", "combat"), { recursive: true });
  for (const file of ["dnd-npc.yaml", "coc-npc.yaml", "grail-npc.yaml"]) {
    copyFileSync(resolve(import.meta.dir, "..", "combat", file), join(root, "src", "combat", file));
  }
  mkdirSync(join(frontend, "assets"), { recursive: true });
  writeFileSync(join(frontend, "index.html"), "<!doctype html><div id=app>fixture</div>");
  writeFileSync(join(frontend, "assets", "app-abcdefgh.js"), "export const fixture = true;");
  writeFileSync(join(frontend, "assets", "app..js"), "export const legal = true;");
  return { root, frontend };
}

async function availablePort(): Promise<number> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const { port } = reservation;
  await reservation.stop(true);
  if (typeof port !== "number") throw new Error("Bun did not report the reserved port");
  return port;
}

function start(root: string, frontend: string, port: number): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, serverEntry], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(port),
      FRONTEND_DIR: frontend,
      LLM_DISABLED: "1",
      COMPILER_OPERATOR_BEARER_TOKEN: "static-delivery-operator-token".padEnd(40, "o"),
      COMPILER_KEEPER_BEARER_TOKEN: "static-delivery-keeper-token".padEnd(40, "k"),
    },
  });
}

async function waitForStartup(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("server stdout is unavailable");
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

describe("server static delivery wiring", () => {
  test("uses the guarded delivery boundary for assets and SPA fallback without a frontend dist dependency", async () => {
    const fixture = fixtureRoot();
    const port = await availablePort();
    const child = start(fixture.root, fixture.frontend, port);
    try {
      await waitForStartup(child);

      const asset = await fetch(`http://127.0.0.1:${port}/assets/app-abcdefgh.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe("export const fixture = true;");
      expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(asset.headers.get("X-Content-Type-Options")).toBe("nosniff");

      const assetHead = await fetch(`http://127.0.0.1:${port}/assets/app-abcdefgh.js`, { method: "HEAD" });
      expectSameStaticMetadata(asset, assetHead);
      expect(await assetHead.text()).toBe("");

      const legalDots = await fetch(`http://127.0.0.1:${port}/assets/app..js`);
      expect(legalDots.status).toBe(200);

      const spaFallback = await fetch(`http://127.0.0.1:${port}/adventure/room-7`);
      expect(spaFallback.status).toBe(200);
      expect(await spaFallback.text()).toContain("fixture");
      expect(spaFallback.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");

      const spaFallbackHead = await fetch(`http://127.0.0.1:${port}/adventure/room-7`, { method: "HEAD" });
      expectSameStaticMetadata(spaFallback, spaFallbackHead);
      expect(await spaFallbackHead.text()).toBe("");

      const missingAsset = await fetch(`http://127.0.0.1:${port}/assets/missing.js`);
      expect(missingAsset.status).toBe(404);

      const missingAssetHead = await fetch(`http://127.0.0.1:${port}/assets/missing.js`, { method: "HEAD" });
      expect(missingAssetHead.status).toBe(404);

      for (const method of ["POST", "PUT", "OPTIONS"]) {
        const nonGet = await fetch(`http://127.0.0.1:${port}/adventure/room-7`, { method });
        expect(nonGet.status, method).toBe(404);
      }
    } finally {
      await stop(child);
    }
  }, 20_000);
});
