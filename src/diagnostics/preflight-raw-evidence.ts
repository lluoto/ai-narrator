import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapturedProcess } from "./process-capture";

/** Save the existing capture, never dispatch another process or change its verdict. */
export function persistPreflightTestEvidence(
  captured: CapturedProcess,
  root = "analysis/diag",
): string {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "preflight-bun-test-"));
  writeFileSync(join(directory, "stdout.log"), captured.stdout, "utf8");
  writeFileSync(join(directory, "stderr.log"), captured.stderr, "utf8");
  const stream = (text: string) => ({
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
  // Raw logs and capture-error detail stay in the ignored local directory.
  // The caller prints only its path, not stdout/stderr or error messages.
  writeFileSync(join(directory, "capture.json"), JSON.stringify({
    status: captured.status,
    signal: captured.signal,
    error: captured.error ? { name: captured.error.name, message: captured.error.message } : null,
    stdout: stream(captured.stdout),
    stderr: stream(captured.stderr),
  }, null, 2), "utf8");
  return directory;
}
