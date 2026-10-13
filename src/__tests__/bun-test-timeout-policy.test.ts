import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("test preload isolates local state without claiming a cross-file timeout policy", () => {
  const bunfig = readFileSync("bunfig.toml", "utf8");
  const preload = readFileSync("scripts/test-preload.ts", "utf8");
  expect(bunfig).toMatch(/\[test\][\s\S]*preload\s*=\s*\["\.\/scripts\/test-preload\.ts"\]/);
  expect(preload).not.toContain("jest.setTimeout");
  expect(bunfig).not.toMatch(/\[test\][\s\S]*\btimeout\b/);
});

test("preflight runner ceiling admits the largest verified bounded filesystem fixture", () => {
  const preflight = readFileSync("scripts/preflight.ts", "utf8");
  const ordinarySnapshotStore = readFileSync("src/__tests__/ordinary-session-snapshot-store.test.ts", "utf8");
  expect(ordinarySnapshotStore).toMatch(/test\("keeps 200 committed action receipts compact[\s\S]*?\}, 30_000\);/);
  expect(preflight).toContain('await captureProcess("bun", ["test", "--parallel=1", "--timeout", "30000"])');
  expect(preflight).toContain('from "../src/diagnostics/process-capture"');
  expect(preflight).toContain("runner-level per-test default");
});

test("the verified heavy fixtures use the narrowest real Bun timeout scope", () => {
  const store = readFileSync("src/__tests__/session-store-resilience.test.ts", "utf8");
  const ordinaryDurable = readFileSync("src/__tests__/ordinary-session-durable-http.test.ts", "utf8");
  const ordinaryTerminal = readFileSync("src/__tests__/ordinary-terminal-reason.test.ts", "utf8");
  const configAccess = readFileSync("src/__tests__/server-config-access-control.test.ts", "utf8");
  expect(store).toMatch(/it\("fails closed when every root entry[\s\S]*?\}, 20_000\);/);
  expect(ordinaryDurable).toMatch(/import \{ describe, expect, test, jest \} from "bun:test";/);
  expect(ordinaryDurable).toMatch(/jest\.setTimeout\(20_000\);/);
  expect(ordinaryDurable).not.toMatch(/test\("a predecessor-directory retirement race[\s\S]*?\}, 20_000\);/);
  expect(ordinaryTerminal).toMatch(/import \{ expect, it \} from "bun:test";/);
  expect(ordinaryTerminal).toMatch(/it\("persists, replays, restarts, and fail-closes an ordinary departure receipt"[\s\S]*?\}, 20_000\);/);
  expect(ordinaryTerminal).not.toContain("setDefaultTimeout");
  expect(configAccess).toMatch(/test\("leaves the anonymous health route public and configuration-free"[\s\S]*?\}, 20_000\);/);
  expect(`${ordinaryTerminal}\n${configAccess}`).not.toMatch(/(?:setDefaultTimeout|jest\.setTimeout)\(\s*Infinity\s*\)|\b(?:test|it)\.retry\s*\(/);
});
