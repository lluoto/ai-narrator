/**
 * A real LLMClient owns the global fetch transport and reads the process
 * override at construction time.  Provider-shape assertions therefore run in
 * a child Bun test process: the parent suite keeps its offline default while
 * the child explicitly opts into its local fake provider.
 */
const PROVIDER_SEAM_CHILD_ENV = "AITRPG_PROVIDER_SEAM_CHILD";

export function isProviderSeamChild(): boolean {
  return process.env[PROVIDER_SEAM_CHILD_ENV] === "1";
}

export async function runProviderSeamChild(testFile: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "test", testFile], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    // The test preload respects explicit false.  Nothing in the parent test
    // isolate (including its fetch mock, breaker, or process environment) is
    // changed by this provider-capable probe.
    env: {
      ...process.env,
      [PROVIDER_SEAM_CHILD_ENV]: "1",
      LLM_DISABLED: "false",
      LLM_MODE: "",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`isolated provider seam test failed (${exitCode}):\n${stderr || stdout}`);
  }
}

/**
 * Keep the original test count and names in the parent suite.  Each file has
 * one single-flight child run, so several provider-sensitive assertions can
 * await the same isolated proof without multiplying child processes.
 */
export function isolatedProviderSeamIt(testFile: string): (
  name: string,
  callback: () => void | Promise<void>,
  timeout?: number,
) => void {
  let proof: Promise<void> | undefined;
  return (name, callback, timeout) => {
    if (isProviderSeamChild()) {
      it(name, callback, timeout);
      return;
    }
    it(name, () => (proof ??= runProviderSeamChild(testFile)), timeout);
  };
}
import { it } from "bun:test";
