import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { GameSession } from "../api/game-session";
import {
  ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
  OrdinarySessionSnapshotStore,
  createOrdinarySessionEnvelope,
} from "../api/ordinary-session-snapshot-store";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { SessionNamespaceCoordinator, type DurableSessionIdentity } from "../api/session-namespace-coordinator";
import type { SessionNamespacePublicationGate } from "../api/session-namespace-publication";

const serverEntry = resolve(import.meta.dir, "..", "api", "server.ts");
const roots = new Set<string>();
const CONFIG = { apiKey: "sk-startup-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "server-main-namespace-"));
  // GameSession's production rules loader resolves this project-relative
  // asset from CWD.  The child still runs the real server entrypoint; this is
  // just the minimal immutable runtime asset it normally receives from the
  // repository checkout.
  mkdirSync(join(value, "src", "rules"), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "..", "rules", "dnd5e.yaml"), join(value, "src", "rules", "dnd5e.yaml"));
  mkdirSync(join(value, "src", "combat"), { recursive: true });
  for (const file of ["dnd-npc.yaml", "coc-npc.yaml", "grail-npc.yaml"]) {
    copyFileSync(resolve(import.meta.dir, "..", "combat", file), join(value, "src", "combat", file));
  }
  roots.add(value);
  return value;
}

function identity(envelope: { envelopeHash: string; generation: number }): DurableSessionIdentity {
  return { hash: envelope.envelopeHash, generation: envelope.generation, format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT };
}

/** Seed exactly the production g0 publication protocol, not a raw store write. */
function seedCommittedOrdinary(rootPath: string, id: string): void {
  const namespace = new SessionNamespaceCoordinator(join(rootPath, "data", "runtime-session-namespace"));
  const snapshots = new OrdinarySessionSnapshotStore({ root: join(rootPath, "data", "ordinary-sessions") });
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "server-main-startup-owner" });
  const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined,
    { careerRoot: join(rootPath, "seed-careers") }, access, "development_fallback");
  try {
    const envelope = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 0, previousEnvelopeHash: null, access,
      snapshot: source.exportOrdinarySessionSnapshot(), idempotency: [],
    });
    const gate: SessionNamespacePublicationGate = { required: true, consume: namespace.consumePublicationPermit.bind(namespace) };
    const prepared = namespace.prepare({ reservation: namespace.reserve({ sessionId: id, kind: "ordinary" }), expectedIdentity: identity(envelope) });
    const result = namespace.publishPrepared({
      reservation: prepared,
      publish: (permit) => {
        const saved = snapshots.save(envelope, { permit }, gate);
        if (saved.status !== "ok") return { status: "not-published" as const, failureCode: saved.code };
        const read = snapshots.read(id);
        return read.status === "ok" && read.value.envelopeHash === envelope.envelopeHash
          ? { status: "published" as const, observedIdentity: identity(envelope) }
          : { status: "indeterminate" as const };
      },
    });
    if (result.status !== "committed") throw new Error(`failed to seed committed ordinary session: ${result.status}`);
  } finally { source.close(); }
}

async function waitForStartup(child: ReturnType<typeof Bun.spawn>, phrase: string): Promise<string> {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("server main child stdout is unavailable");
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`server main did not report ${phrase}: ${output}`)), 8_000); });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timedOut]);
      if (next.done) {
        const stderr = child.stderr && typeof child.stderr !== "number" ? await new Response(child.stderr).text() : "";
        throw new Error(`server main exited before startup (exit ${await child.exited}): ${output}\n${stderr}`);
      }
      output += decoder.decode(next.value, { stream: true });
      if (output.includes(phrase)) return output;
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

async function exited(child: ReturnType<typeof Bun.spawn>): Promise<{ code: number; stdout: string; stderr: string }> {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout && typeof child.stdout !== "number" ? new Response(child.stdout).text() : Promise.resolve(""),
    child.stderr && typeof child.stderr !== "number" ? new Response(child.stderr).text() : Promise.resolve(""),
  ]);
  return { code, stdout, stderr };
}

function startMain(rootPath: string, port: number): ReturnType<typeof Bun.spawn> {
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "__CAREER_DIR"),
  );
  return Bun.spawn([process.execPath, serverEntry], {
    cwd: rootPath,
    stdout: "pipe", stderr: "pipe",
    // The production default resolves this exact path from the child's CWD.
    // Exclude parent test-only overrides case-insensitively: another file can
    // temporarily set __CAREER_DIR while this child starts. Its ordinary
    // envelope is authoritative for the fixture's own default root.
    env: { ...childEnvironment, PORT: String(port), LLM_DISABLED: "1" },
  });
}

describe("server main namespace startup barrier", () => {
  test("real main quarantines a same-ID malformed metadata locator before ordinary hydration can create a career", async () => {
    const rootPath = root(); const id = "12345678-1234-4123-8123-123456789abd";
    seedCommittedOrdinary(rootPath, id);
    mkdirSync(join(rootPath, "data", "sessions"), { recursive: true });
    writeFileSync(join(rootPath, "data", "sessions", `${id}.json`), "{ broken metadata", "utf8");
    const child = startMain(rootPath, 39291);
    try {
      const output = await waitForStartup(child, "API:");
      expect(output).toContain("Hydrated 0 ordinary session(s); 1 unavailable");
      expect(new SessionNamespaceCoordinator(join(rootPath, "data", "runtime-session-namespace")).read(id))
        .toMatchObject({ state: "quarantined", reasonCode: "METADATA_LOCATOR_INVALID" });
      expect(existsSync(join(rootPath, "data", "careers", id))).toBe(false);
    } finally { await stop(child); }
  }, 20_000);

  test("real main still hydrates one exact committed ordinary pointer", async () => {
    const rootPath = root(); const id = "12345678-1234-4123-8123-123456789abe";
    seedCommittedOrdinary(rootPath, id);
    // g0 is permitted to initialize this real, physically empty target root;
    // it is not a license to replace a nonempty third Career projection.
    mkdirSync(join(rootPath, "data", "careers", id), { recursive: true });
    const child = startMain(rootPath, 39292);
    try {
      const output = await waitForStartup(child, "API:");
      expect(output).toContain("Hydrated 1 ordinary session(s); 0 unavailable");
      expect(new SessionNamespaceCoordinator(join(rootPath, "data", "runtime-session-namespace")).read(id))
        .toMatchObject({ kind: "ordinary", state: "committed", expectedIdentity: { generation: 0 } });
      expect(existsSync(join(rootPath, "data", "careers", id, ".career-active.json"))).toBe(true);
    } finally { await stop(child); }
  }, 20_000);

  test("real main does not re-inventory a malformed post-start metadata locator for an anonymous health request", async () => {
    const rootPath = root(); const postStartId = "12345678-1234-4123-8123-123456789abf";
    const child = startMain(rootPath, 39294);
    try {
      await waitForStartup(child, "API:");
      expect(existsSync(join(rootPath, "data", "runtime-session-namespace"))).toBe(true);
      mkdirSync(join(rootPath, "data", "sessions"), { recursive: true });
      writeFileSync(join(rootPath, "data", "sessions", `${postStartId}.json`), "{ malformed post-start metadata", "utf8");

      const response = await fetch("http://127.0.0.1:39294/api");
      expect(response.status).toBe(200);
      // A request-time inventory would quarantine this collision evidence.
      // The production coordinator completed its inventory before listening,
      // so post-start state cannot affect an anonymous health check.
      expect(new SessionNamespaceCoordinator(join(rootPath, "data", "runtime-session-namespace")).read(postStartId))
        .toBeUndefined();
    } finally { await stop(child); }
  }, 20_000);

  test("real main fails before listening when the namespace root is an unsafe regular file", async () => {
    const rootPath = root(); const port = 39293;
    mkdirSync(join(rootPath, "data"), { recursive: true });
    // This is deterministic on every supported filesystem: coordinator path
    // safety requires its root to be a real directory, so main must throw
    // during startup inventory rather than ever reaching Bun.serve.
    writeFileSync(join(rootPath, "data", "runtime-session-namespace"), "unsafe namespace root", "utf8");
    const child = startMain(rootPath, port);
    const result = await exited(child);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("API:");
    expect(`${result.stdout}\n${result.stderr}`).toContain("durable startup coordination failed");
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  }, 20_000);
});
