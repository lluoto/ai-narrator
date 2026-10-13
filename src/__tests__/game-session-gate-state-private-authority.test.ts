import { expect, it } from "bun:test";
import { GameSession } from "../api/game-session";

const CONFIG = {
  apiKey: "sk-gate-state-authority",
  baseUrl: "http://gate-state-authority.invalid/v1",
  model: "fixture",
  maxTokens: 32,
  temperature: 0,
};

function fresh(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
}

function canonicalDifficulty(session: GameSession): string | null | undefined {
  return session.exportOrdinarySessionSnapshot().state.activeDifficulty;
}

function expectMediumToHard(session: GameSession): void {
  const result = session.setDifficulty("hard");
  expect(result).toMatchObject({
    ok: true,
    value: { changes: [{ variable: "difficulty", from: "medium", to: "hard" }] },
  });
  expect(canonicalDifficulty(session)).toBe("hard");
  expect((session.getKPState() as { difficulty: { label: string } | null }).difficulty?.label).toBe("hard");
}

function forgedGate(session: GameSession, difficulty: string): unknown {
  const canonical = session.getGateState();
  return {
    ...canonical,
    variables: { ...canonical.variables, difficulty },
  };
}

for (const difficulty of ["hard", "easy", "not-a-difficulty"]) {
  it(`does not let an own getGateState=${difficulty} shadow rewrite a medium-to-hard transition`, () => {
    const session = fresh(`gate-state-own-${difficulty}-${crypto.randomUUID()}`);
    try {
      const forged = forgedGate(session, difficulty);
      Object.defineProperty(session, "getGateState", { configurable: true, value: () => forged });

      // The public wrapper remains an ordinary JavaScript observation. This is
      // intentionally not the canonical source used by setDifficulty.
      expect((session as unknown as { getGateState(): unknown }).getGateState()).toEqual(forged);
      expectMediumToHard(session);
    } finally {
      session.close();
    }
  });
}

for (const [label, descriptor] of [
    ["undefined", { value: () => undefined }],
    ["throwing", { get: () => { throw new Error("forged gate-state getter"); } }],
  ] as const) {
  it(`does not let an own ${label} getGateState shadow block a legal persisted transition`, () => {
    const session = fresh(`gate-state-own-${label}-${crypto.randomUUID()}`);
    try {
      Object.defineProperty(session, "getGateState", { configurable: true, ...descriptor });
      if (label === "throwing") {
        expect(() => (session as unknown as { getGateState(): unknown }).getGateState()).toThrow("forged gate-state getter");
      } else {
        expect((session as unknown as { getGateState(): unknown }).getGateState()).toBeUndefined();
      }
      expect(() => expectMediumToHard(session)).not.toThrow();
    } finally {
      session.close();
    }
  });
}

it("does not let a temporary getGateState prototype shadow contaminate independent sessions", () => {
  const original = Object.getOwnPropertyDescriptor(GameSession.prototype, "getGateState");
  if (!original) throw new Error("fixture requires the public gate-state wrapper");
  const left = fresh(`gate-state-prototype-left-${crypto.randomUUID()}`);
  const right = fresh(`gate-state-prototype-right-${crypto.randomUUID()}`);
  const forged = forgedGate(left, "easy");
  try {
    Object.defineProperty(GameSession.prototype, "getGateState", {
      configurable: true,
      writable: true,
      value: () => forged,
    });
    const leftResult = left.setDifficulty("hard");
    const rightResult = right.setDifficulty("hard");
    expect(leftResult).toMatchObject({ ok: true, value: { changes: [{ variable: "difficulty", from: "medium", to: "hard" }] } });
    expect(rightResult).toMatchObject({ ok: true, value: { changes: [{ variable: "difficulty", from: "medium", to: "hard" }] } });
    expect(canonicalDifficulty(left)).toBe("hard");
    expect(canonicalDifficulty(right)).toBe("hard");
  } finally {
    Object.defineProperty(GameSession.prototype, "getGateState", original);
    left.close();
    right.close();
  }
});

it("keeps the existing target-domain refusal", () => {
  const ordinary = fresh(`gate-state-invalid-target-${crypto.randomUUID()}`);
  try {
    expect(ordinary.setDifficulty("not-a-difficulty")).toMatchObject({
      ok: false,
      error: { code: "value_out_of_domain" },
    });
  } finally {
    ordinary.close();
  }
});
