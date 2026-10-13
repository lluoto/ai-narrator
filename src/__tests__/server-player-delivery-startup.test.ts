import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Database } from "bun:sqlite";
import { CompiledPlayerDeliveryClaimCoordinator } from "../api/player-delivery-claim-coordinator";

const SERVER_ENTRY = resolve(import.meta.dir, "..", "api", "server.ts");
const SERVE_MARKER_PRELOAD = resolve(import.meta.dir, "fixtures", "server-runtime-config-serve-marker-preload.ts");
const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function runtimeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "server-player-delivery-startup-"));
  mkdirSync(join(root, "src", "rules"), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "..", "rules", "dnd5e.yaml"), join(root, "src", "rules", "dnd5e.yaml"));
  mkdirSync(join(root, "src", "combat"), { recursive: true });
  for (const file of ["dnd-npc.yaml", "coc-npc.yaml", "grail-npc.yaml"]) {
    copyFileSync(resolve(import.meta.dir, "..", "combat", file), join(root, "src", "combat", file));
  }
  roots.add(root);
  return root;
}

function start(root: string, environment: Record<string, string>) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
    "PORT",
    "COMPILER_PLAYER_DELIVERY_HMAC_SECRET",
    "COMPILER_PLAYER_DELIVERY_ROOT",
    "COMPILER_PUBLIC_ORIGIN",
    "COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS",
    "COMPILER_PLAYER_DELIVERY_COOKIE_TTL_SECONDS",
  ].includes(key)));
  return Bun.spawn([process.execPath, "--preload", SERVE_MARKER_PRELOAD, SERVER_ENTRY], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, LLM_DISABLED: "1", SESSION_TIMEOUT_MINUTES: "30", NODE_ENV: "production", ...environment },
  });
}

async function completed(child: ReturnType<typeof start>): Promise<{ code: number; stdout: string; stderr: string }> {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout && typeof child.stdout !== "number" ? new Response(child.stdout).text() : Promise.resolve(""),
    child.stderr && typeof child.stderr !== "number" ? new Response(child.stderr).text() : Promise.resolve(""),
  ]);
  return { code, stdout, stderr };
}

async function waitForStartup(child: ReturnType<typeof start>): Promise<void> {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("server stdout unavailable");
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 8_000);
  });
  try {
    while (true) {
      const read = await Promise.race([reader.read(), timedOut]);
      if (read.value) output += decoder.decode(read.value, { stream: true });
      if (output.includes("API:")) return;
      if (read.done) throw new Error(`server exited before startup: ${output}`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
}

async function stop(child: ReturnType<typeof start>): Promise<void> {
  try { child.kill(); } catch { /* already stopped */ }
  await child.exited;
}

describe("server player-delivery startup", () => {
  test("an enabled unsafe delivery root or coordinator policy aborts before Bun.serve", async () => {
    for (const kind of ["root", "policy"] as const) {
      const root = runtimeRoot();
      const deliveryRoot = join(root, "data", `delivery-${kind}`);
      const marker = join(root, `serve-${kind}`);
      if (kind === "root") {
        mkdirSync(join(root, "data"), { recursive: true });
        writeFileSync(deliveryRoot, "unsafe root", "utf8");
      } else {
        mkdirSync(deliveryRoot, { recursive: true });
        const coordinator = new CompiledPlayerDeliveryClaimCoordinator(deliveryRoot);
        coordinator.initialize();
        const database = new Database(coordinator.file);
        try {
          database.run("DROP TABLE compiled_player_delivery_claim_coordinator_policy");
          database.run("CREATE TABLE compiled_player_delivery_claim_coordinator_policy (singleton INTEGER PRIMARY KEY)");
        } finally { database.close(); }
      }
      const child = start(root, {
        PORT: "3099",
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: "d".repeat(48),
        COMPILER_PUBLIC_ORIGIN: "https://example.test",
        COMPILER_PLAYER_DELIVERY_ROOT: deliveryRoot,
        __SERVER_RUNTIME_CONFIG_SERVE_MARKER: marker,
        __SERVER_RUNTIME_CONFIG_SERVE_THROW: "1",
      });
      const result = await completed(child);
      expect(result.code, kind).not.toBe(0);
      expect(existsSync(marker), kind).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`, kind).toContain("durable startup coordination failed");
    }
  }, 20_000);

  test("disabled delivery starts without creating its configured root", async () => {
    const root = runtimeRoot();
    const deliveryRoot = join(root, "not-created-when-disabled");
    const child = start(root, {
      PORT: "3098",
      COMPILER_PLAYER_DELIVERY_HMAC_SECRET: "",
      COMPILER_PUBLIC_ORIGIN: "",
      COMPILER_PLAYER_DELIVERY_ROOT: deliveryRoot,
    });
    try {
      await waitForStartup(child);
      expect(existsSync(deliveryRoot)).toBe(false);
    } finally { await stop(child); }
  }, 20_000);

  test("main owns exactly one initialized delivery singleton and injects it into requests", () => {
    const source = readFileSync(SERVER_ENTRY, "utf8");
    expect(source.match(/const serverPlayerDelivery = createEnvironmentPlayerDelivery\(\);/g)).toHaveLength(1);
    expect(source).toContain("serverPlayerDelivery.initialize();");
    const singletonUse = source.indexOf("serverPlayerDelivery,", source.indexOf("const liveServer = Bun.serve"));
    expect(singletonUse).toBeGreaterThan(source.indexOf("const liveServer = Bun.serve"));
  });
});
