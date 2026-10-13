import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const serverEntry = resolve(import.meta.dir, "..", "api", "server.ts");
const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function reservePort(): Promise<number> {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  try {
    if (listener.port === undefined) throw new Error("ephemeral test listener did not report a port");
    return listener.port;
  } finally {
    await listener.stop(true);
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

interface StartedMain {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
}

function startMain(root: string, port: number): StartedMain {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
    "PORT", "NODE_ENV", "ORDINARY_SESSION_AUTH_MODE",
    "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS",
    "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION",
    "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL",
  ].includes(key)));
  const child = Bun.spawn([process.execPath, serverEntry], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...inherited,
      LLM_DISABLED: "1",
      PORT: String(port),
      NODE_ENV: "development",
      ORDINARY_SESSION_AUTH_MODE: "development_anonymous",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS: "1",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION: "1",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL: "1",
    },
  });
  // Start consuming both pipes immediately. A verbose child must not become
  // blocked on a full OS pipe while this test waits on its listener.
  return {
    child,
    stdout: child.stdout && typeof child.stdout !== "number" ? new Response(child.stdout).text() : Promise.resolve(""),
    stderr: child.stderr && typeof child.stderr !== "number" ? new Response(child.stderr).text() : Promise.resolve(""),
  };
}

async function stop(main: StartedMain): Promise<{ code: number; stdout: string; stderr: string }> {
  try { main.child.kill(); } catch { /* child already stopped */ }
  const [code, stdout, stderr] = await Promise.all([main.child.exited, main.stdout, main.stderr]);
  return { code, stdout, stderr };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("websocket connection failed"));
  });
}

function waitForClose(socket: WebSocket, description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), 2_000);
    socket.onclose = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

describe("ordinary websocket admission real main wiring", () => {
  test("Bun upgrade carries the opaque lease: max-one blocks a second handshake and close allows reconnection", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-ws-admission-main-"));
    roots.add(root);
    const port = await reservePort();
    const main = startMain(root, port);
    const url = `ws://127.0.0.1:${port}/ws?session=ordinary-development-session`;
    let first: WebSocket | undefined;
    let second: WebSocket | undefined;
    let third: WebSocket | undefined;
    try {
      await waitUntil(async () => {
        try { return (await fetch(`http://127.0.0.1:${port}/api`)).ok; } catch { return false; }
      }, "main listener");
      first = await connect(url);

      let secondOpened = false;
      await new Promise<void>((resolve) => {
        second = new WebSocket(url);
        second.onopen = () => { secondOpened = true; resolve(); };
        second.onerror = () => resolve();
        setTimeout(resolve, 500);
      });
      expect(secondOpened).toBe(false);

      const firstClosed = waitForClose(first, "first websocket close");
      first.close();
      await firstClosed;
      third = await connect(url);
      expect(third.readyState).toBe(WebSocket.OPEN);
    } finally {
      first?.close();
      second?.close();
      third?.close();
      const result = await stop(main);
      if (result.code !== 0 && result.code !== 143) {
        throw new Error(`main exited unexpectedly (${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      }
    }
  }, 20_000);
});
