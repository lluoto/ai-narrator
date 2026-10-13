import { captureProcess } from "./process-capture";
import {
  judgeProcess,
  judgeTestCount,
  parseTestOutput,
  type TestBaseline,
  type TestCount,
} from "./source-scan";

/** Complete, parsed result of a test child process. */
export interface TestRunEvidence {
  ok: boolean;
  reason: string;
  output: string;
  count: TestCount;
}

/**
 * Runs a test command while draining both streams, then judges its real exit
 * status and terminal Bun summary. A startup/capture failure, truncated output,
 * nonzero exit, or incomplete summary is never reported as green.
 */
export async function collectTestRunEvidence(
  command: string,
  args: string[],
  baseline: TestBaseline,
): Promise<TestRunEvidence> {
  const result = await captureProcess(command, args);
  const output = `${result.stdout}\n${result.stderr}`;
  const count = parseTestOutput(output);
  const processVerdict = judgeProcess("bun test", result);
  if (!processVerdict.ok) {
    return { ok: false, reason: processVerdict.reason, output, count };
  }

  const summary = judgeTestCount(count, baseline);
  if (summary.problems.length > 0) {
    return { ok: false, reason: summary.problems.join("；"), output, count };
  }
  return { ok: true, reason: "", output, count };
}
