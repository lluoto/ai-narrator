import { expect, test } from "bun:test";
import { nativeFetchIsolationTestInternals } from "./helpers/isolated-native-fetch";

test("isolated native-fetch custom timeout reserves error-drain time", () => {
  const budget = nativeFetchIsolationTestInternals.budgetForRequestedTimeout(2_000);
  expect(budget.parentTimeoutMs).toBe(2_000);
  expect(budget.watchdogTimeoutMs).toBeLessThan(budget.parentTimeoutMs);
  expect(Math.max(
    budget.startupTimeoutMs,
    budget.childTestTimeoutMs,
    budget.childRunnerTimeoutMs,
    budget.exitTimeoutMs,
  )).toBeLessThanOrEqual(budget.watchdogTimeoutMs);
  expect(() => nativeFetchIsolationTestInternals.budgetForRequestedTimeout(1_999)).toThrow(/at least 2000ms/);
});

test("isolated native-fetch watchdog records ready and terminates only its hung child", async () => {
  const started = performance.now();
  await expect(nativeFetchIsolationTestInternals.runNativeFetchIsolationChild(
    "./src/__tests__/helpers/isolated-native-fetch-child-fixture.ts",
    "isolated native-fetch child fixture",
    "reports ready before it hangs",
    {
      parentTimeoutMs: 1_000,
      watchdogTimeoutMs: 800,
      startupTimeoutMs: 500,
      childTestTimeoutMs: 150,
      childRunnerTimeoutMs: 500,
      exitTimeoutMs: 100,
    },
    { AITRPG_NATIVE_FETCH_TEST_FIXTURE: "hang" },
  )).rejects.toThrow(/bounded ready phase/);
  expect(performance.now() - started).toBeLessThan(1_000);
}, 2_000);

test("isolated native-fetch custom budget terminates a ready hung child before its parent deadline", async () => {
  const budget = nativeFetchIsolationTestInternals.budgetForRequestedTimeout(2_000);
  const started = performance.now();
  await expect(nativeFetchIsolationTestInternals.runNativeFetchIsolationChild(
    "./src/__tests__/helpers/isolated-native-fetch-child-fixture.ts",
    "isolated native-fetch child fixture",
    "reports ready before it hangs",
    budget,
    { AITRPG_NATIVE_FETCH_TEST_FIXTURE: "hang" },
  )).rejects.toThrow(/bounded ready phase/);
  expect(performance.now() - started).toBeLessThan(budget.parentTimeoutMs);
}, 3_000);
