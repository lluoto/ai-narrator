import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProcess } from "../diagnostics/process-capture";
import { persistPreflightTestEvidence } from "../diagnostics/preflight-raw-evidence";

describe("preflight raw evidence persistence", () => {
  test("retains a real nonzero capture's complete Expected/Received, separate streams and byte hashes", async () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-raw-evidence-test-"));
    try {
      const stdout = "raw stdout 中文\n";
      const stderr = '- Expected - 1\n- status: "sampled"\n+ Received + 1\n+ status: "refused"\n';
      const captured = await captureProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(17);`]);
      expect(captured.status).toBe(17);
      expect(captured.error).toBeUndefined();
      const directory = persistPreflightTestEvidence(captured, root);
      expect(readFileSync(join(directory, "stdout.log"), "utf8")).toBe(stdout);
      expect(readFileSync(join(directory, "stderr.log"), "utf8")).toBe(stderr);
      expect(JSON.parse(readFileSync(join(directory, "capture.json"), "utf8"))).toEqual({
        status: 17, signal: null, error: null,
        stdout: { bytes: Buffer.byteLength(stdout), sha256: createHash("sha256").update(stdout).digest("hex") },
        stderr: { bytes: Buffer.byteLength(stderr), sha256: createHash("sha256").update(stderr).digest("hex") },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not overwrite a previous run and keeps capture-error and signal evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-raw-evidence-test-"));
    try {
      const first = persistPreflightTestEvidence({ status: 0, signal: null, stdout: "first", stderr: "" }, root);
      const second = persistPreflightTestEvidence({ status: null, signal: "SIGTERM", error: new Error("fixture capture limit"), stdout: "partial", stderr: "error" }, root);
      expect(first).not.toBe(second);
      expect(readFileSync(join(first, "stdout.log"), "utf8")).toBe("first");
      expect(readFileSync(join(second, "stderr.log"), "utf8")).toBe("error");
      expect(JSON.parse(readFileSync(join(second, "capture.json"), "utf8"))).toMatchObject({
        status: null, signal: "SIGTERM", error: { name: "Error", message: "fixture capture limit" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on a failed save instead of returning fabricated evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-raw-evidence-test-"));
    try {
      const fileRoot = join(root, "not-a-directory");
      writeFileSync(fileRoot, "existing file");
      expect(() => persistPreflightTestEvidence({ status: 0, signal: null, stdout: "", stderr: "" }, fileRoot)).toThrow();
      expect(readFileSync(fileRoot, "utf8")).toBe("existing file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
