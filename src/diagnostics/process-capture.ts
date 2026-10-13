import { spawn, type ChildProcess } from "child_process";

/** A process result shaped for the shared preflight exit-status verdict. */
export interface CapturedProcess {
  error?: Error;
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface CaptureProcessOptions {
  /**
   * Combined stdout/stderr ceiling. Crossing it is capture failure, never a
   * successful result with a partial terminal summary.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * Starts a command without a shell and drains stdout/stderr concurrently.
 *
 * `spawnSync` applies a bounded capture buffer. Full test output can exceed it
 * before its terminal summary is emitted, which leaves preflight unable to
 * distinguish a real test failure from its own truncated child output.
 */
export function captureProcess(
  command: string,
  args: string[],
  { maxBytes = DEFAULT_MAX_CAPTURE_BYTES }: CaptureProcessOptions = {},
): Promise<CapturedProcess> {
  return new Promise((resolve) => {
    let settled = false;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const finish = (result: CapturedProcess) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({
        error: error instanceof Error ? error : new Error(String(error)),
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
      });
      return;
    }

    let captureError: Error | undefined;
    const captureFailure = (error: Error) => {
      captureError ??= error;
      // A stream we cannot fully read is not valid test evidence. Stop the
      // child, then wait for close so this helper never strands a subprocess.
      if (!child.killed) child.kill();
    };
    let capturedBytes = 0;
    const collect = (target: Uint8Array[], chunk: Uint8Array) => {
      if (captureError) return;
      const nextBytes = capturedBytes + chunk.byteLength;
      if (nextBytes > maxBytes) {
        captureFailure(new Error(`process output exceeded capture limit of ${maxBytes} bytes`));
        return;
      }
      capturedBytes = nextBytes;
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Uint8Array) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => collect(stderr, chunk));
    child.stdout?.once("error", captureFailure);
    child.stderr?.once("error", captureFailure);
    child.once("error", (error) => {
      finish({
        error,
        status: null,
        signal: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.once("close", (status, signal) => {
      finish({
        error: captureError,
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
