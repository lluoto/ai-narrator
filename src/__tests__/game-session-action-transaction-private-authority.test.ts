import { expect, test } from "bun:test";
import type { NPCPersonality } from "../agent/types";
import { GameSession } from "../api/game-session";
import { NPCStore } from "../db";
import { WorldStateManager } from "../state/world-state-manager";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";

type ShadowMode = "assignment" | "defineProperty";

const shadowModes: readonly ShadowMode[] = ["assignment", "defineProperty"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function shadowRuntimeOwnField(session: GameSession, key: string, value: unknown, mode: ShadowMode): void {
  const target = session as unknown as Record<string, unknown>;
  if (mode === "assignment") {
    target[key] = value;
    return;
  }
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

async function drainPromiseJobs(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

function freshSession(name: string): GameSession {
  return new GameSession(
    `transaction-private-${name}-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
  );
}

function requiredIntentFailureSession(name: string, reply?: string): GameSession {
  return new GameSession(
    `transaction-private-required-${name}-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "required",
    reply === undefined ? undefined : { sessionIntentClient: { chat: async () => reply } },
  );
}

type CanonicalSanity = { currentSAN: number; maxSAN: number };

function canonicalSanity(value: unknown, label: string): CanonicalSanity {
  if (!value || typeof value !== "object") throw new Error(`test setup has no SAN object at ${label}`);
  const record = value as Record<string, unknown>;
  if (typeof record.currentSAN !== "number" || typeof record.maxSAN !== "number") {
    throw new Error(`test setup has invalid SAN at ${label}`);
  }
  return { currentSAN: record.currentSAN, maxSAN: record.maxSAN };
}

function responseSanity(response: Awaited<ReturnType<GameSession["act"]>>): NonNullable<typeof response.sanity> {
  if (!response.sanity) throw new Error("ordinary action response omitted SAN");
  return response.sanity;
}

function snapshotSanityFor(snapshot: ReturnType<GameSession["exportOrdinarySessionSnapshot"]>, pcId = "p1") {
  const sessionSanity = canonicalSanity(
    snapshot.state.sanities.find((entry) => entry.pcId === pcId)?.state,
    `session ${pcId}`,
  );
  const worldSanity = canonicalSanity(
    snapshot.world.tables.player_state.find((entry) => entry.entity_id === pcId)?.sanity,
    `world ${pcId}`,
  );
  return { sessionSanity, worldSanity };
}

function expectResponseToMatchOrdinarySnapshot(
  response: Awaited<ReturnType<GameSession["act"]>>,
  snapshot: ReturnType<GameSession["exportOrdinarySessionSnapshot"]>,
): void {
  const { sessionSanity, worldSanity } = snapshotSanityFor(snapshot);
  expect(response.state.round).toBe(snapshot.state.round);
  expect(responseSanity(response)).toMatchObject({
    currentSAN: sessionSanity.currentSAN,
    maxSAN: sessionSanity.maxSAN,
  });
  expect(worldSanity.currentSAN).toBe(sessionSanity.currentSAN);
  expect(response.dead).toBe(snapshot.state.dead);
  expect(response.terminal).toEqual(snapshot.state.terminal);
}

const NPC_STAMP_PROBE: NPCPersonality = {
  name: "source-stamp-probe",
  role: "probe",
  personality: "",
  background: "",
  speech_style: "",
  goals: [],
  knowledge: [],
  secrets: [],
  attitudes: {},
  ruleset: "cosmic-horror",
  traits: {
    courage: 7,
    friendliness: 8,
    suspicion: 4,
    curiosity: 9,
    stability: 6,
  },
  factions: [],
  initialMood: "neutral",
};

/**
 * Default GameSession stores are deliberately private. Capture the exact test
 * instance only while its approved portable export calls the store's existing
 * snapshot method, then restore the shared prototype before any ABA write.
 */
function captureSessionOwnedNPCStore(session: GameSession): NPCStore {
  const prototype = NPCStore.prototype as unknown as {
    exportSnapshot: (...args: unknown[]) => unknown;
  };
  const original = prototype.exportSnapshot;
  let captured: NPCStore | undefined;
  const capture = function capture(this: NPCStore, ...args: unknown[]): unknown {
    captured = this;
    return original.apply(this, args);
  };
  prototype.exportSnapshot = capture;
  try {
    session.exportOrdinarySessionSnapshot();
  } finally {
    if (prototype.exportSnapshot === capture) prototype.exportSnapshot = original;
  }
  if (!captured) throw new Error("test setup could not capture the session-owned NPCStore");
  return captured;
}

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

for (const mode of shadowModes) {
  test(`a ${mode} shadow cannot make a later action transaction bypass its FIFO predecessor`, async () => {
    const session = freshSession(`fifo-${mode}`);
    const unblockFirst = deferred<void>();
    const events: string[] = [];
    let firstReleased = false;
    let secondEnteredBeforeFirstRelease = false;
    try {
      const first = session.runExclusiveActionTransaction(async () => {
        events.push("first-entered");
        await unblockFirst.promise;
        firstReleased = true;
        events.push("first-released");
      });
      await drainPromiseJobs();
      expect(events).toEqual(["first-entered"]);

      // This is the real public transaction API; the test never consults an
      // internal transaction count to decide whether the follower may enter.
      shadowRuntimeOwnField(session, "actionTransactionTail", Promise.resolve(), mode);
      const second = session.runExclusiveActionTransaction(async () => {
        if (!firstReleased) secondEnteredBeforeFirstRelease = true;
        events.push("second-entered");
      });
      await drainPromiseJobs();

      expect(secondEnteredBeforeFirstRelease).toBe(false);
      expect(events).toEqual(["first-entered"]);

      unblockFirst.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-entered", "first-released", "second-entered"]);
    } finally {
      unblockFirst.resolve();
      session.close();
    }
  });

  test(`a ${mode} shadow cannot authorize an ordinary snapshot export during an active transaction`, async () => {
    const session = freshSession(`snapshot-${mode}`);
    try {
      await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction) => {
        // The only sanctioned pre-action capability still works inside this
        // exact FIFO boundary; a public export must not acquire that authority.
        expect(() => snapshotBeforeAction()).not.toThrow();
        shadowRuntimeOwnField(session, "ordinaryCommitSnapshotExport", true, mode);
        expect(() => session.exportOrdinarySessionSnapshot()).toThrow(
          "ordinary portable snapshot export is forbidden while an action is in flight",
        );
      });
    } finally {
      session.close();
    }
  });

  test(`a ${mode} shadow cannot erase a facade ABA interval from the source-state guard`, async () => {
    const session = freshSession(`facade-aba-${mode}`);
    try {
      // Keep the semantic source state explicit, then make the public hard ->
      // medium round trip after the source snapshot has been captured.
      expect(session.setDifficulty("medium").ok).toBe(true);
      const capturedRevision = Reflect.get(session, "facadeMutationRevision");
      await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
        snapshotBeforeAction();
        expect(session.setDifficulty("hard").ok).toBe(true);
        expect(session.setDifficulty("medium").ok).toBe(true);
        // In the vulnerable runtime-own implementation this restores the
        // exact captured value while every portable value is back at medium;
        // a private slot returns no authority through reflection, so this is
        // only an irrelevant decoy.
        shadowRuntimeOwnField(session, "facadeMutationRevision", capturedRevision, mode);
        expect(sourceState.isPreActionSnapshotCurrent()).toBe(false);
      });
    } finally {
      session.close();
    }
  });
}

test("a constant world SQLite stamp shadow cannot hide a same-connection raw world ABA from the source fence", async () => {
  const session = freshSession("world-sqlite-stamp-aba");
  let rawWorld: WorldStateManager | undefined;
  const restoreCapture = patchGameSessionWorldMethod(session, "getDatabase", (original, receiver, args) => {
    rawWorld = receiver;
    return original.apply(receiver, args);
  });
  try {
    // Capture the default private world before installing the shadow. This is
    // the same approved pre-action snapshot path that takes the stamp.
    await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction) => {
      snapshotBeforeAction();
    });
    if (!rawWorld) throw new Error("test setup could not capture the raw world");
    const world = rawWorld;

    const forgedStamp = world.getDatabase()
      .query("SELECT CAST(total_changes() AS TEXT) AS revision")
      .get() as { revision: string };
    shadowRuntimeOwnField(session, "worldSqliteMutationStamp", () => forgedStamp.revision, "assignment");
    await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
      snapshotBeforeAction();
      const before = world.exportSnapshot();
      // This writes through the exact SQLite connection sampled by the source
      // fence, then restores every portable world row byte-for-byte.
      world.getDatabase().run("UPDATE entities SET hp = hp - 1 WHERE id = ?", ["p1"]);
      world.restoreSnapshot(before);
      expect(world.exportSnapshot()).toEqual(before);
      expect(sourceState.isPreActionSnapshotCurrent()).toBe(false);
    });
  } finally {
    restoreCapture();
    session.close();
  }
});

test("a constant NPC SQLite stamp shadow cannot hide a private-store save and restore ABA from the source fence", async () => {
  const session = freshSession("npc-sqlite-stamp-aba");
  try {
    const rawStore = captureSessionOwnedNPCStore(session);
    shadowRuntimeOwnField(session, "npcStoreSqliteMutationStamp", () => "forged-stamp", "assignment");
    await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
      snapshotBeforeAction();
      const before = rawStore.exportSnapshot();
      rawStore.savePersonality(NPC_STAMP_PROBE);
      rawStore.restoreSnapshot(before);
      expect(rawStore.exportSnapshot()).toEqual(before);
      expect(sourceState.isPreActionSnapshotCurrent()).toBe(false);
    });
  } finally {
    session.close();
  }
});

for (const helper of ["worldSqliteMutationStamp", "npcStoreSqliteMutationStamp"] as const) {
  test(`a throwing ${helper} shadow cannot DoS a real pre-action source snapshot`, async () => {
    const session = freshSession(`${helper}-throw`);
    try {
      shadowRuntimeOwnField(session, helper, () => {
        throw new Error(`forged ${helper}`);
      }, "assignment");
      await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
        expect(() => snapshotBeforeAction()).not.toThrow();
        expect(sourceState.isPreActionSnapshotCurrent()).toBe(true);
      });
    } finally {
      session.close();
    }
  });
}

test("an exact unmodified source snapshot remains current across both SQLite stamp guards", async () => {
  const session = freshSession("sqlite-stamp-noop");
  try {
    await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
      snapshotBeforeAction();
      expect(sourceState.isPreActionSnapshotCurrent()).toBe(true);
    });
  } finally {
    session.close();
  }
});

test("a no-op facade-revision helper shadow cannot erase a real public difficulty ABA from the source fence", async () => {
  const session = freshSession("facade-helper-aba");
  try {
    expect(session.setDifficulty("medium").ok).toBe(true);
    shadowRuntimeOwnField(session, "bumpFacadeMutationRevision", () => undefined, "assignment");
    await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
      snapshotBeforeAction();
      expect(session.setDifficulty("hard").ok).toBe(true);
      expect(session.setDifficulty("medium").ok).toBe(true);
      expect(sourceState.isPreActionSnapshotCurrent()).toBe(false);
    });
  } finally {
    session.close();
  }
});

test("a throwing facade-revision helper shadow cannot DoS a normal public difficulty mutation", () => {
  const session = freshSession("facade-helper-throw");
  try {
    shadowRuntimeOwnField(session, "bumpFacadeMutationRevision", () => {
      throw new Error("forged facade revision helper");
    }, "assignment");
    expect(() => session.setDifficulty("hard")).not.toThrow();
    expect(session.setDifficulty("medium").ok).toBe(true);
    expect(session.exportOrdinarySessionSnapshot().state.activeDifficulty).toBe("medium");
  } finally {
    session.close();
  }
});

test("a fake or throwing actUnlocked shadow cannot replace or DoS a real deterministic /help action", async () => {
  const fake = freshSession("act-unlocked-fake");
  try {
    const beforeRound = fake.round;
    const beforeHistory = fake.getHistory().total;
    shadowRuntimeOwnField(fake, "actUnlocked", async () => ({
      narrative: "forged action response",
      events: [],
      state: { round: -1 },
    }), "assignment");
    const result = await fake.act("/help");
    expect(result.narrative).not.toBe("forged action response");
    expect(result.state.round).toBe(beforeRound + 1);
    expect(fake.round).toBe(beforeRound + 1);
    expect(fake.getHistory().total).toBeGreaterThan(beforeHistory);
  } finally {
    fake.close();
  }

  const throwing = freshSession("act-unlocked-throw");
  try {
    const beforeRound = throwing.round;
    shadowRuntimeOwnField(throwing, "actUnlocked", async () => {
      throw new Error("forged unlocked executor");
    }, "assignment");
    await expect(throwing.act("/help")).resolves.toMatchObject({ state: { round: beforeRound + 1 } });
    expect(throwing.getHistory().total).toBeGreaterThan(0);
  } finally {
    throwing.close();
  }
});

for (const mode of shadowModes) {
  for (const [label, shadow] of [
    ["forged", async () => ({
      narrative: "forged transaction response",
      events: [],
      state: { round: 999 },
    })],
    ["throwing", async () => { throw new Error("forged public transaction dispatcher"); }],
  ] as const) {
    test(`a ${mode} ${label} public transaction-dispatch shadow cannot replace or DoS a canonical direct action`, async () => {
      const session = freshSession(`public-transaction-dispatch-${mode}-${label}`);
      try {
        const beforeRound = session.round;
        const beforeHistory = session.getHistory().total;
        shadowRuntimeOwnField(session, "runExclusiveActionTransaction", shadow, mode);

        const result = await session.act("/help");

        expect(result.narrative).not.toBe("forged transaction response");
        expect(result.state.round).toBe(beforeRound + 1);
        expect(session.round).toBe(beforeRound + 1);
        expect(session.getHistory().total).toBeGreaterThan(beforeHistory);
      } finally {
        session.close();
      }
    });
  }
}

for (const [label, shadow] of [
  ["no-op", () => undefined],
  ["throwing", () => { throw new Error("forged fail-stop helper"); }],
] as const) {
  test(`a ${label} failStopDirectAction shadow cannot undo a real late-action fail-stop`, async () => {
    const session = freshSession(`fail-stop-${label}`);
    const restoreFault = patchGameSessionWorldMethod(session, "setPlayerSanity", () => {
      throw new Error("transaction authority persistence fault");
    });
    try {
      shadowRuntimeOwnField(session, "failStopDirectAction", shadow, "assignment");
      await expect(session.act("/roll 1d6")).rejects.toThrow("transaction authority persistence fault");
    } finally {
      restoreFault();
    }
    try {
      await expect(session.act("/help")).rejects.toThrow(
        "GameSession is unavailable after a prior action failure",
      );
    } finally {
      session.close();
    }
  });
}

for (const [label, shadow] of [
  ["false", () => false],
  ["throwing", () => { throw new Error("forged lifecycle predicate"); }],
] as const) {
  test(`a ${label} direct-action lifecycle shadow cannot report a live deterministic action as closed or DoS it`, async () => {
    const session = freshSession(`live-lifecycle-${label}`);
    try {
      const beforeRound = session.round;
      const beforeHistory = session.getHistory().total;
      shadowRuntimeOwnField(session, "directActionLifecycleIsCurrent", shadow, "assignment");
      const result = await session.act("/help");
      expect(result.error).toBeUndefined();
      expect(result.state.round).toBe(beforeRound + 1);
      expect(session.round).toBe(beforeRound + 1);
      expect(session.getHistory().total).toBeGreaterThan(beforeHistory);
    } finally {
      session.close();
    }
  });
}

test("a true lifecycle shadow cannot acknowledge an intent that became stale during an external close", async () => {
  const reply = deferred<string>();
  const started = deferred<void>();
  const session = new GameSession(
    `transaction-private-close-race-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { sessionIntentClient: { chat: () => { started.resolve(); return reply.promise; } } },
  );
  try {
    shadowRuntimeOwnField(session, "directActionLifecycleIsCurrent", () => true, "assignment");
    const pending = session.act("opaque direct-action lifecycle probe");
    await started.promise;
    session.close();
    reply.resolve(JSON.stringify({ action: "help" }));
    await expect(settleWithin(pending, "stale direct action")).rejects.toThrow(
      "closed GameSession cannot accept actions",
    );
  } finally {
    reply.resolve(JSON.stringify({ action: "help" }));
    session.close();
  }
});

for (const [label, shadow] of [
  ["fake", () => new Error("forged closed-session error")],
  ["throwing", () => { throw new Error("forged closed-error helper"); }],
] as const) {
  test(`a ${label} closed-action error helper shadow cannot change the stable closed-session contract`, async () => {
    const session = freshSession(`closed-error-${label}`);
    session.close();
    shadowRuntimeOwnField(session, "closedDirectActionError", shadow, "assignment");
    await expect(session.act("/help")).rejects.toThrow("closed GameSession cannot accept actions");
  });
}

for (const [label, shadow] of [
  ["fake", () => ({
    narrative: "forged action response",
    events: [],
    state: { round: 999 },
    sanity: { currentSAN: 999, maxSAN: 999 },
    dead: true,
    terminal: { kind: "module_departure", endingId: "forged", endingName: "forged" },
  })],
  ["throwing", () => { throw new Error("forged action response helper"); }],
] as const) {
  test(`a ${label} buildActionResponse shadow cannot replace a committed ordinary response or skip its commit cleanup`, async () => {
    const session = freshSession(`build-response-${label}`);
    try {
      const beforeRound = session.round;
      const beforeHistory = session.getHistory().total;
      const beforeSan = session.getSanity();
      shadowRuntimeOwnField(session, "buildActionResponse", shadow, "assignment");

      const response = await session.act("/roll 1d6");
      const snapshot = session.exportOrdinarySessionSnapshot();

      expect(response.narrative).not.toBe("forged action response");
      expect(response.state.round).toBe(beforeRound + 1);
      expect(session.round).toBe(beforeRound + 1);
      expect(session.getHistory().total).toBeGreaterThan(beforeHistory);
      expectResponseToMatchOrdinarySnapshot(response, snapshot);
      expect(responseSanity(response).currentSAN).toBe(beforeSan.currentSAN);
    } finally {
      session.close();
    }
  });
}

for (const [label, shadow] of [
  ["no-op", () => undefined],
  ["throwing", () => { throw new Error("forged SAN persistence helper"); }],
] as const) {
  test(`a ${label} persistSanity shadow cannot split public SAN from world and ordinary snapshot truth`, async () => {
    const session = freshSession(`persist-sanity-${label}`);
    try {
      const targetSan = Math.max(1, session.getSanity().currentSAN - 1);
      shadowRuntimeOwnField(session, "persistSanity", shadow, "assignment");

      expect(session.setPlayerSan("p1", targetSan).ok).toBe(true);
      const response = await session.act("/roll 1d6");
      const snapshot = session.exportOrdinarySessionSnapshot();
      const { sessionSanity, worldSanity } = snapshotSanityFor(snapshot);

      expect(session.getSanity().currentSAN).toBe(targetSan);
      expect(responseSanity(response).currentSAN).toBe(targetSan);
      expect(sessionSanity.currentSAN).toBe(targetSan);
      expect(worldSanity.currentSAN).toBe(targetSan);
      expectResponseToMatchOrdinarySnapshot(response, snapshot);
    } finally {
      session.close();
    }
  });
}

for (const scenario of [
  { label: "unavailable", reply: undefined, code: "intent_model_unavailable" },
  { label: "invalid", reply: "not an ActionIntent JSON", code: "intent_model_invalid" },
] as const) {
  for (const [label, shadow] of [
    ["fake", () => ({ narrative: "forged success", events: [], state: { round: 999 } })],
    ["throwing", () => { throw new Error("forged intent-policy response helper"); }],
  ] as const) {
    test(`a ${label} intentPolicyFailure shadow cannot replace a required ${scenario.label} intent refusal`, async () => {
      const session = requiredIntentFailureSession(`intent-policy-${scenario.label}-${label}`, scenario.reply);
      try {
        const beforeRound = session.round;
        const beforeHistory = session.getHistory().total;
        shadowRuntimeOwnField(session, "intentPolicyFailure", shadow, "assignment");

        const refused = await session.act("opaque required-provider response authority probe");
        expect(refused.error?.code).toBe(scenario.code);
        expect(refused.state.round).toBe(beforeRound);
        expect(session.round).toBe(beforeRound);
        expect(session.getHistory().total).toBe(beforeHistory);

        const legal = await session.act("/help");
        expect(legal.error).toBeUndefined();
        expect(legal.state.round).toBe(beforeRound + 1);
        expect(session.getHistory().total).toBeGreaterThan(beforeHistory);
      } finally {
        session.close();
      }
    });
  }
}

for (const [label, install] of [
  ["fake", (session: GameSession) => {
    shadowRuntimeOwnField(session, "getState", () => ({ round: 999, player: { name: "forged" } }), "assignment");
    shadowRuntimeOwnField(session, "getSanity", () => ({ currentSAN: 999, maxSAN: 999 }), "assignment");
    shadowRuntimeOwnField(session, "getOrdinaryTerminal", () => ({ kind: "module_departure", endingId: "forged", endingName: "forged" }), "assignment");
    Object.defineProperty(session, "dead", { value: true, configurable: true, writable: true });
  }],
  ["throwing", (session: GameSession) => {
    for (const name of ["getState", "getSanity", "getOrdinaryTerminal"]) {
      shadowRuntimeOwnField(session, name, () => { throw new Error(`forged ${name} projection`); }, "assignment");
    }
    Object.defineProperty(session, "dead", {
      configurable: true,
      get: () => { throw new Error("forged dead projection"); },
    });
  }],
] as const) {
  test(`a ${label} public projection shadow cannot alter an ordinary action response`, async () => {
    const session = freshSession(`public-projection-${label}`);
    try {
      const beforeRound = session.round;
      const beforeSan = session.getSanity();
      install(session);

      const response = await session.act("/roll 1d6");

      expect(response.state.round).toBe(beforeRound + 1);
      expect(responseSanity(response).currentSAN).toBe(beforeSan.currentSAN);
      expect(response.terminal).toBeNull();
      expect(response.dead).toBe(false);
      expect(session.getHistory().total).toBeGreaterThan(0);
    } finally {
      session.close();
    }
  });
}

for (const [label, shadow] of [
  ["fake", () => ({ round: 999, player: { name: "forged" } })],
  ["throwing", () => { throw new Error("forged unknown-target state projection"); }],
] as const) {
  test(`a ${label} getState shadow cannot forge or DoS an ordinary unknown-target refusal`, async () => {
    const session = freshSession(`unknown-target-${label}`);
    try {
      const beforeRound = session.round;
      shadowRuntimeOwnField(session, "getState", shadow, "assignment");

      const refused = await session.act("/help", "not-a-party-member");

      expect(refused.error).toEqual({ code: "unknown_target", targetId: "not-a-party-member" });
      expect(refused.state.round).toBe(beforeRound);
      expect(session.round).toBe(beforeRound);
      expect(session.getHistory().total).toBe(0);
    } finally {
      session.close();
    }
  });
}

for (const [label, shadow] of [
  ["fake", () => ({ currentSAN: 999, maxSAN: 999 })],
  ["throwing", () => { throw new Error("forged status SAN projection"); }],
] as const) {
  test(`a ${label} getSanity shadow cannot forge or DoS ordinary status narration`, async () => {
    const session = requiredIntentFailureSession(`status-sanity-${label}`, JSON.stringify({ action: "status" }));
    try {
      const beforeSan = session.getSanity();
      shadowRuntimeOwnField(session, "getSanity", shadow, "assignment");

      const response = await session.act("provider-issued status request");
      const narrative = [response.narrative, ...response.events.map((event) => event.content)].join("\n");

      expect(responseSanity(response).currentSAN).toBe(beforeSan.currentSAN);
      expect(narrative).toContain(`SAN: ${beforeSan.currentSAN}/${beforeSan.maxSAN}`);
      expect(narrative).not.toContain("999/999");
    } finally {
      session.close();
    }
  });
}
