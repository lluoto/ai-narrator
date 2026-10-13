import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { captureProcess } from "../diagnostics/process-capture";
import { judgeProcess } from "../diagnostics/source-scan";

const streamBytes = 1_200_000;
const childProgram = [
  `const stdout = "o".repeat(${streamBytes});`,
  `const stderr = "e".repeat(${streamBytes});`,
  "process.stdout.write(stdout);",
  "process.stderr.write(stderr);",
].join("\n");

function errorCode(error: Error | undefined): string | undefined {
  const code = error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

test("synchronous default buffering overflows while captured output drains both streams", async () => {
  const old = spawnSync(process.execPath, ["-e", childProgram], { encoding: "utf8" });
  expect(errorCode(old.error)).toBe("ENOBUFS");

  const result = await captureProcess(process.execPath, ["-e", childProgram]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("o".repeat(streamBytes));
  expect(result.stderr).toBe("e".repeat(streamBytes));
  expect(judgeProcess("large output", result)).toEqual({ ok: true, reason: "" });
});

test("captured process resolves Bun without a shell", async () => {
  const result = await captureProcess("bun", ["--version"]);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout.trim()).toBe(Bun.version);
  expect(result.stderr).toBe("");
});

test("captured process preserves nonzero exits and both output streams", async () => {
  const result = await captureProcess(process.execPath, [
    "-e",
    'process.stdout.write("out"); process.stderr.write("err"); process.exit(17);',
  ]);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(17);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("out");
  expect(result.stderr).toBe("err");
  expect(judgeProcess("nonzero", result)).toEqual({ ok: false, reason: "nonzero 退出码 17" });
});

test("capture limit is an explicit failure rather than a truncated success", async () => {
  const result = await captureProcess(process.execPath, ["-e", childProgram], { maxBytes: 1_000 });

  expect(result.error?.message).toContain("capture limit");
  expect(result.status).not.toBe(0);
  expect(judgeProcess("limited", result).ok).toBe(false);
});

test("captured process preserves signal termination", async () => {
  const result = await captureProcess(process.execPath, [
    "-e",
    'process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1_000);',
  ]);

  expect(result.error).toBeUndefined();
  // Windows reports forced SIGTERM termination as exit code 1; POSIX exposes
  // the signal. The capture result must preserve the platform's real report.
  if (process.platform === "win32") {
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
  } else {
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  }
});

test("captured process reports startup errors without a fabricated exit", async () => {
  const result = await captureProcess("definitely-not-a-preflight-command", []);

  expect(errorCode(result.error)).toBe("ENOENT");
  expect(result.status).toBeNull();
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(judgeProcess("missing", result).ok).toBe(false);
});
