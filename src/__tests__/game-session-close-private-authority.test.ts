import { afterEach, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { CompanionManager } from "../combat/companion-manager";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";

type ShadowTarget = "own" | "prototype";
type CloseShadow = "no-op" | "throwing";
const CLOSED_READ_ERROR = "closed GameSession cannot read session state";

const sessions: GameSession[] = [];
const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
  while (sessions.length > 0) {
    try { sessions.pop()!.close(); } catch { /* the test already closed its authority */ }
  }
});

function fresh(
  label: string,
  id = `close-private-authority-${label}-${crypto.randomUUID()}`,
  withCharacter = true,
): GameSession {
  const session = new GameSession(
    id,
    "cosmic-horror",
    undefined,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
  );
  sessions.push(session);
  return session;
}

function shadowPublicClose(session: GameSession, target: ShadowTarget, shadow: CloseShadow): () => void {
  const receiver = target === "own" ? session : GameSession.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(receiver, "close");
  Object.defineProperty(receiver, "close", {
    configurable: true,
    writable: true,
    value: shadow === "no-op"
      ? () => undefined
      : () => { throw new Error("forged public close"); },
  });
  const restore = () => {
    if (descriptor) Object.defineProperty(receiver, "close", descriptor);
    else Reflect.deleteProperty(receiver, "close");
  };
  restorers.push(restore);
  return restore;
}

function assertPublicCloseShadowRemainsObservable(session: GameSession, shadow: CloseShadow): void {
  if (shadow === "no-op") {
    expect(session.close()).toBeUndefined();
    expect(() => session.exportOrdinarySessionSnapshot()).not.toThrow();
  } else {
    expect(() => session.close()).toThrow("forged public close");
  }
}

/** Keep facade identity stable while requiring its later invocations to fail closed. */
function captureSessionBoundReaders(session: GameSession) {
  return {
    session: session.session,
    sanity: session.sanity,
    investigation: session.investigation,
    registry: session.registry,
    companions: session.companionManager,
    kp: session.kp,
    politicoEconomy: session.politicoEconomy,
  };
}

/** Retained facades must cross the same lifecycle boundary as direct projections. */
function assertSessionBoundReadersFailClosed(
  session: GameSession,
  retained = captureSessionBoundReaders(session),
): void {
  const reads: Array<() => unknown> = [
    () => session.round,
    () => session.activePlayerId,
    () => session.activeCharacter,
    () => session.dead,
    () => session.combatActive,
    () => session.skillGrowthMarks,
    () => session.skillMarks,
    () => session.getOrdinaryTerminal(),
    () => session.getSanity(),
    () => session.getCharacterSummary(),
    () => session.getHistory(),
    () => session.getPlayerHistory("p1"),
    () => session.getGateState(),
    () => session.getOrdinarySessionAccessBinding(),
    () => retained.session.getAllNames(),
    () => retained.sanity.state,
    () => retained.investigation.listClueTypes(),
    () => retained.registry.count,
    () => retained.companions.getActiveCompanions(),
    () => retained.kp.getTurns(),
    () => retained.politicoEconomy.getBriefState(),
    // These currently happen to reach a closed SQLite handle. They should
    // expose the same lifecycle error instead of a driver-specific one.
    () => session.getState(),
    () => session.getSummary(),
    () => session.getOrdinaryCharacterEditorProjection(),
    () => session.getPlayerPosition(),
    () => session.getDisplayedScene(),
    () => session.isClueFound("irrelevant"),
    () => session.isSceneVisited("irrelevant"),
    () => session.isEarlyGame(),
    () => session.getKPState(),
    () => session.getSuggestions(),
  ];
  for (const read of reads) expect(read).toThrow(CLOSED_READ_ERROR);
}

test("normal close seals direct projections and retained session-bound readers", () => {
  const session = fresh("public-readers");
  const retained = captureSessionBoundReaders(session);
  session.close();
  assertSessionBoundReadersFailClosed(session, retained);

  // Retired identity/reference diagnostics remain explicitly readable and
  // cannot be treated as a liveness probe.
  expect(session.id).toContain("close-private-authority-public-readers-");
  expect(session.createdAt).toBeGreaterThan(0);
  expect(session.activeRuleset).toBe("cosmic-horror");
  expect(session.isDurableCompiledSession()).toBe(false);
  expect(session.getOrdinaryDurableIdentity()).toBeNull();
});

test("an ordinary restore fault after CompanionManager application seals its partial PlayerSession cohort", () => {
  const id = `close-private-authority-companion-restore-${crypto.randomUUID()}`;
  const source = fresh("companion-source", id, true);
  const targetSession = fresh("companion-target", id, false);
  const added = source.addPartyMember("Bea", "detective");
  expect(added).not.toHaveProperty("rejected");
  const snapshot = source.exportOrdinarySessionSnapshot();
  const retained = captureSessionBoundReaders(targetSession);
  const original = CompanionManager.prototype.restoreSnapshot;
  let invoked = false;
  (CompanionManager.prototype as unknown as { restoreSnapshot: (...args: unknown[]) => unknown }).restoreSnapshot = function (...args: unknown[]) {
    original.apply(this, args as Parameters<CompanionManager["restoreSnapshot"]>);
    invoked = true;
    throw new Error("injected after companion restore");
  };
  try {
    expect(() => targetSession.restoreOrdinarySessionSnapshot(snapshot)).toThrow(
      "ordinary snapshot restore failed closed: injected after companion restore",
    );
    expect(invoked).toBe(true);
    assertSessionBoundReadersFailClosed(targetSession, retained);
  } finally {
    CompanionManager.prototype.restoreSnapshot = original;
  }
});

for (const target of ["own", "prototype"] as const) {
  for (const shadow of ["no-op", "throwing"] as const) {
    test(`${target} ${shadow} public close shadow cannot block direct-action fail-stop closure`, async () => {
      const session = fresh(`${target}-${shadow}-direct`);
      const restoreClose = shadowPublicClose(session, target, shadow);
      const restoreFault = patchGameSessionWorldMethod(session, "setPlayerSanity", () => {
        throw new Error("close private authority direct persistence fault");
      });
      const retained = captureSessionBoundReaders(session);
      try {
        // Public close remains ordinary dynamic JavaScript dispatch. This is a
        // negative control, not a claim that the public surface is frozen.
        assertPublicCloseShadowRemainsObservable(session, shadow);

        await expect(session.act("/roll 1d6")).rejects.toThrow(
          "close private authority direct persistence fault",
        );
        // The direct-action latch also rejects, but only canonical export
        // proves that raw world/NPC lifetime was actually retired.
        expect(() => session.exportOrdinarySessionSnapshot()).toThrow(
          "closed GameSession cannot be exported",
        );
        await expect(session.act("/help")).rejects.toThrow(
          "GameSession is unavailable after a prior action failure",
        );
        assertSessionBoundReadersFailClosed(session, retained);
      } finally {
        restoreFault();
        restoreClose();
      }
    });

    test(`${target} ${shadow} public close shadow cannot block restore-failure closure`, () => {
      const id = `close-private-authority-${target}-${shadow}-restore-${crypto.randomUUID()}`;
      const source = fresh(`${target}-${shadow}-source`, id, false);
      const targetSession = fresh(`${target}-${shadow}-target`, id, false);
      const snapshot = source.exportOrdinarySessionSnapshot();
      const restoreClose = shadowPublicClose(targetSession, target, shadow);
      const restoreFault = patchGameSessionWorldMethod(targetSession, "restoreSnapshot", () => {
        throw new Error("close private authority restore fault");
      });
      try {
        // The source snapshot is valid for this same-ID pristine target, so
        // this fault occurs inside the post-validation apply try block.
        assertPublicCloseShadowRemainsObservable(targetSession, shadow);
        expect(() => targetSession.restoreOrdinarySessionSnapshot(snapshot)).toThrow(
          "ordinary snapshot restore failed closed: close private authority restore fault",
        );
        expect(() => targetSession.exportOrdinarySessionSnapshot()).toThrow(
          "closed GameSession cannot be exported",
        );
      } finally {
        restoreFault();
        restoreClose();
      }
    });
  }
}
