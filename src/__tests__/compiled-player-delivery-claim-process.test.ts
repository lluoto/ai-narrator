import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { CompiledPlayerDelivery, CompiledPlayerDeliveryClaimStore } from "../api/player-delivery";

const CHILD = resolve(import.meta.dir, "compiled-player-delivery-claim-process-child.ts");
const SECRET = "delivery_hmac_secret_".padEnd(48, "d");
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "compiled-player-delivery-claim-process-"));
  roots.add(root);
  return root;
}

function child(...args: string[]) {
  return Bun.spawn([process.execPath, CHILD, ...args], { stdout: "pipe", stderr: "pipe" });
}

async function childResult(process: ReturnType<typeof child>): Promise<Record<string, unknown>> {
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    process.stdout && typeof process.stdout !== "number" ? new Response(process.stdout).text() : Promise.resolve(""),
    process.stderr && typeof process.stderr !== "number" ? new Response(process.stderr).text() : Promise.resolve(""),
  ]);
  if (code !== 0) throw new Error(`claim child failed (${code}): ${stderr || stdout}`);
  const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("claim child emitted no JSON");
  return JSON.parse(line) as Record<string, unknown>;
}

async function waitFor(path: string, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(15);
  }
}

describe("compiled player delivery claim process protocol", () => {
  test("serializes distinct first-writer claims before publication and leaves no contender temp", async () => {
    const root = temporaryRoot();
    const sessionId = "claim-process-session";
    const issuer = new CompiledPlayerDelivery({
      secret: SECRET,
      publicOrigin: "https://example.test",
      claims: new CompiledPlayerDeliveryClaimStore(join(root, "delivery")),
    });
    const invitation = issuer.issue(sessionId);
    if (!invitation) throw new Error("expected invitation");
    const claimRoot = join(root, "delivery");
    const ready = join(root, "writer-ready");
    const release = join(root, "writer-release");
    const winnerId = "a".repeat(43);
    const loserId = "b".repeat(43);
    const encodedGrant = JSON.stringify(invitation.binding);
    const holder = child("claim-hold", claimRoot, sessionId, encodedGrant, invitation.invite, winnerId, ready, release, "");
    let won: Record<string, unknown> | undefined;
    try {
      await waitFor(ready, "writer A before link");

      const before = readdirSync(claimRoot).filter((name) => name.endsWith(".claim.tmp"));
      expect(before).toHaveLength(1);
      const blocked = await childResult(child("claim", claimRoot, sessionId, encodedGrant, invitation.invite, loserId, ready, release, ""));
      expect(blocked.result).toBeNull();
      // A owns the only temporary file while stopped at link; B never reaches a
      // filesystem publication step while the SQLite lock is held.
      expect(readdirSync(claimRoot).filter((name) => name.endsWith(".claim.tmp"))).toEqual(before);

      writeFileSync(release, "release");
      won = await childResult(holder);
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release after assertion failure");
      await holder.exited;
    }
    expect(won?.result).toMatchObject({ cookieValue: expect.any(String) });
    const afterReleaseConflict = await childResult(child("claim", claimRoot, sessionId, encodedGrant, invitation.invite, loserId, ready, release, ""));
    expect(afterReleaseConflict.result).toBeNull();
    expect(readdirSync(claimRoot).filter((name) => name.endsWith(".claim.tmp"))).toEqual([]);
  }, 20_000);

  test("fails closed for descriptor reads and cookie authentication while a real process owns the lock", async () => {
    const root = temporaryRoot();
    const sessionId = "claim-read-lock-session";
    const claimRoot = join(root, "delivery");
    const issuer = new CompiledPlayerDelivery({
      secret: SECRET,
      publicOrigin: "https://example.test",
      claims: new CompiledPlayerDeliveryClaimStore(claimRoot),
    });
    const invitation = issuer.issue(sessionId);
    if (!invitation) throw new Error("expected invitation");
    const issued = issuer.claim(sessionId, invitation.binding, invitation.invite, "c".repeat(43));
    if (!issued) throw new Error("expected first claim");
    const cookie = `${issued.cookieName}=${issued.cookieValue}`;
    const ready = join(root, "lock-ready");
    const release = join(root, "lock-release");
    const encodedGrant = JSON.stringify(invitation.binding);
    const holder = child("lock-hold", claimRoot, "-", "-", "-", "-", ready, release, "-");
    try {
      await waitFor(ready, "read-lock holder");

      const blocked = await childResult(child("authenticate", claimRoot, sessionId, encodedGrant, "-", "-", ready, release, cookie));
      expect(blocked).toEqual({ authenticated: false, read: "undefined" });
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release after assertion failure");
      await childResult(holder);
    }
    const recovered = await childResult(child("authenticate", claimRoot, sessionId, encodedGrant, "-", "-", ready, release, cookie));
    expect(recovered).toEqual({ authenticated: true, read: "value" });
  }, 20_000);
});
