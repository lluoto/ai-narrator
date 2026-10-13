import { expect, test } from "bun:test";
// @ts-ignore Browser-neutral ESM helper consumed by App.vue.
import { ordinaryLuckFromAuthoritativeState, ordinaryLuckFromCreateResponse, ordinaryLuckSpendOutcome, ordinaryLuckSpendRequest, ordinaryLuckSpendVisible, submitOrdinaryLuckSpend } from "../../frontend/src/ordinary-luck-spend-controller.js";

const ready = {
  sessionKind: "ordinary",
  ruleset: "cosmic-horror",
  ordinaryGeneration: 7,
  luck: 12,
  loading: false,
  terminal: null,
  amount: "3",
};

test("ordinary Luck UI only submits a bounded current-generation request", async () => {
  expect(ordinaryLuckSpendVisible(ready)).toBe(true);
  expect(ordinaryLuckSpendVisible({ ...ready, luck: 0 })).toBe(true);
  expect(ordinaryLuckSpendVisible({ ...ready, luck: null })).toBe(false);
  expect(ordinaryLuckSpendVisible({ ...ready, sessionKind: "compiled" })).toBe(false);
  expect(ordinaryLuckSpendRequest(ready)).toEqual({ amount: 3, expectedGeneration: 7 });
  const calls: Array<{ amount: number; expectedGeneration: number }> = [];
  await expect(submitOrdinaryLuckSpend(ready, async (request: { amount: number; expectedGeneration: number }) => {
    calls.push(request);
    return { sessionKind: "ordinary", ordinaryGeneration: 8, luck: 9 };
  })).resolves.toMatchObject({ kind: "submitted", request: { amount: 3, expectedGeneration: 7 } });
  expect(calls).toEqual([{ amount: 3, expectedGeneration: 7 }]);

  for (const invalid of [
    { ...ready, amount: "0" }, { ...ready, amount: "1.5" }, { ...ready, amount: "13" },
    { ...ready, ordinaryGeneration: null }, { ...ready, luck: null }, { ...ready, luck: 0 },
    { ...ready, loading: true }, { ...ready, terminal: { kind: "death" } },
    { ...ready, ruleset: "dnd5e" }, { ...ready, sessionKind: "compiled" },
  ]) {
    await expect(submitOrdinaryLuckSpend(invalid, async (request: { amount: number; expectedGeneration: number }) => {
      calls.push(request);
      return {};
    })).resolves.toEqual({ kind: "not-submitted" });
  }
  expect(calls).toHaveLength(1);
});

test("ordinary Luck UI consumes only canonical create/state/receipt values and distinguishes replay ownership", () => {
  expect(ordinaryLuckFromCreateResponse({ character: { luck: 12 } })).toBe(12);
  expect(ordinaryLuckFromCreateResponse({ character: { luck: 100 } })).toBeNull();
  expect(ordinaryLuckFromAuthoritativeState({ state: { player: { luck: 9 } } })).toBe(9);
  expect(ordinaryLuckFromAuthoritativeState({ state: { player: { luck: 1.5 } } })).toBeNull();
  expect(ordinaryLuckFromAuthoritativeState({ state: { player: {} } })).toBeNull();

  expect(ordinaryLuckSpendOutcome({
    kind: "reconciled", pendingKind: "luck_spend",
    receipt: { ordinaryGeneration: 8, luck: 9 },
    session: { sessionKind: "ordinary", ordinaryGeneration: 8, state: { player: { luck: 9 } } },
  })).toEqual({ kind: "luck-reconciled", luck: 9, ordinaryGeneration: 8 });
  expect(ordinaryLuckSpendRequest({ ...ready, ordinaryGeneration: 8, luck: 9, amount: "2" })).toEqual({ amount: 2, expectedGeneration: 8 });
  expect(ordinaryLuckSpendOutcome({
    kind: "reconciled", pendingKind: "text_action",
    session: { sessionKind: "ordinary", ordinaryGeneration: 8, state: { player: { luck: 9 } } },
  })).toEqual({ kind: "text-reconciled", luck: 9, ordinaryGeneration: 8 });
  expect(ordinaryLuckSpendOutcome({
    kind: "reconciled", pendingKind: "text_action", pendingRetained: true,
    session: { sessionKind: "ordinary", ordinaryGeneration: 8, state: { player: { luck: 9 } } },
  })).toEqual({ kind: "text-pending", luck: 9, ordinaryGeneration: 8 });
  expect(ordinaryLuckSpendOutcome({
    kind: "reconciled", pendingKind: "luck_spend", pendingRetained: true,
    session: { sessionKind: "ordinary", ordinaryGeneration: 8, state: { player: { luck: 9 } } },
  })).toEqual({ kind: "luck-pending", luck: 9, ordinaryGeneration: 8 });
  expect(ordinaryLuckSpendOutcome({
    kind: "reconciled", pendingKind: "luck_spend",
    session: { sessionKind: "ordinary", ordinaryGeneration: 8, state: { player: { luck: 9 } } },
  })).toEqual({ kind: "luck-not-confirmed", luck: 9, ordinaryGeneration: 8 });
  expect(ordinaryLuckSpendOutcome({ sessionKind: "ordinary", ordinaryGeneration: 8, luck: 9 })).toEqual({
    kind: "luck-receipt", luck: 9, ordinaryGeneration: 8,
  });
  expect(ordinaryLuckSpendOutcome({ sessionKind: "ordinary", ordinaryGeneration: 8, luck: 100 })).toEqual({ kind: "invalid" });
});

test("App wires the tested controller into a labelled Luck form", async () => {
  const app = await Bun.file("frontend/src/App.vue").text();
  expect(app).toContain("submitOrdinaryLuckSpend(");
  expect(app).toContain("ordinaryLuckSpendVisibleForSession");
  expect(app).toContain('@submit.prevent="submitLuckSpend"');
  expect(app).toContain('for="ordinary-luck-spend"');
});
