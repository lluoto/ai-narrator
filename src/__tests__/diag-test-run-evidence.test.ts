import { expect, test } from "bun:test";
import { collectTestRunEvidence } from "../diagnostics/test-run-evidence";

const streamBytes = 1_200_000;
const terminalSummary = "\n 7 pass\n 0 fail\nRan 7 tests across 3 files.\n";
const childProgram = [
  `const stdout = "o".repeat(${streamBytes});`,
  `const stderr = "e".repeat(${streamBytes});`,
  "process.stdout.write(stdout);",
  "process.stderr.write(stderr);",
  `process.stdout.write(${JSON.stringify(terminalSummary)});`,
].join("\n");

test("large test output is drained before terminal evidence is judged", async () => {
  const evidence = await collectTestRunEvidence(
    process.execPath,
    ["-e", childProgram],
    { tests: 7, files: 3 },
  );

  expect(evidence.ok).toBe(true);
  expect(evidence.count).toEqual({ tests: 7, files: 3, passed: 7, skipped: null, failed: 0 });
  expect(evidence.output).toContain(terminalSummary.trim());
  expect(evidence.output).toContain("e".repeat(streamBytes));
});

test("nonzero or unparseable test evidence cannot be reported green", async () => {
  const nonzero = await collectTestRunEvidence(
    process.execPath,
    ["-e", 'process.stdout.write(" 7 pass\\n 0 fail\\nRan 7 tests across 3 files.\\n"); process.exit(17);'],
    { tests: 7, files: 3 },
  );
  expect(nonzero.ok).toBe(false);
  expect(nonzero.reason).toContain("退出码 17");

  const unparseable = await collectTestRunEvidence(
    process.execPath,
    ["-e", 'process.stdout.write("finished without a test summary\\n");'],
    { tests: 7, files: 3 },
  );
  expect(unparseable.ok).toBe(false);
  expect(unparseable.reason).toContain("没解析到测试条数");
});
