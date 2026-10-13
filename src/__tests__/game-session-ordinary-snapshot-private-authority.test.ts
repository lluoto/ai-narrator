import { expect, test } from "bun:test";
import { GameSession } from "../api/game-session";

type Snapshot = ReturnType<GameSession["exportOrdinarySessionSnapshot"]>;
type ShadowTarget = "own" | "prototype";

function freshSession(label: string): GameSession {
  return new GameSession(
    `ordinary-snapshot-authority-${label}-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "detective",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
  );
}

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

/**
 * Deliberately shadows the still-public observation API. The production
 * transaction capability must not dynamically dispatch through this surface.
 */
function shadowOrdinaryExport(
  session: GameSession,
  target: ShadowTarget,
  replacement: GameSession["exportOrdinarySessionSnapshot"],
): () => void {
  const receiver = target === "own" ? session : GameSession.prototype;
  const original = Object.getOwnPropertyDescriptor(receiver, "exportOrdinarySessionSnapshot");
  Object.defineProperty(receiver, "exportOrdinarySessionSnapshot", {
    configurable: true,
    writable: true,
    value: replacement,
  });
  return () => restoreProperty(receiver, "exportOrdinarySessionSnapshot", original);
}

function expectHard(snapshot: Snapshot): void {
  expect(snapshot.state.activeDifficulty).toBe("hard");
}

for (const target of ["own", "prototype"] as const) {
  test(`a ${target} fake ordinary export remains observable but cannot forge a transaction snapshot`, async () => {
    const session = freshSession(`${target}-fake-snapshot`);
    try {
      const stale = session.exportOrdinarySessionSnapshot();
      expect(session.setDifficulty("hard")).toMatchObject({ ok: true });
      const canonical = session.exportOrdinarySessionSnapshot();
      expectHard(canonical);

      const restore = shadowOrdinaryExport(session, target, () => stale);
      try {
        // Public observation compatibility is intentional: this is the
        // negative control, and must keep calling the installed shadow.
        expect(session.exportOrdinarySessionSnapshot()).toBe(stale);
        await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction) => {
          const captured = snapshotBeforeAction();
          expect(captured).toEqual(canonical);
          expectHard(captured);
        });
      } finally {
        restore();
      }
    } finally {
      session.close();
    }
  });

  test(`a ${target} throwing ordinary export cannot block a transaction snapshot`, async () => {
    const session = freshSession(`${target}-throw-snapshot`);
    try {
      const canonical = session.exportOrdinarySessionSnapshot();
      const restore = shadowOrdinaryExport(session, target, () => {
        throw new Error("forged ordinary export failure");
      });
      try {
        expect(() => session.exportOrdinarySessionSnapshot()).toThrow("forged ordinary export failure");
        await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction) => {
          expect(snapshotBeforeAction()).toEqual(canonical);
        });
      } finally {
        restore();
      }
    } finally {
      session.close();
    }
  });

  for (const kind of ["fake", "throwing"] as const) {
    test(`a ${target} ${kind} ordinary export installed after capture cannot falsify source-state currency`, async () => {
      const session = freshSession(`${target}-${kind}-source-state`);
      try {
        const stale = session.exportOrdinarySessionSnapshot();
        expect(session.setDifficulty("hard")).toMatchObject({ ok: true });

        await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
          const captured = snapshotBeforeAction();
          expectHard(captured);
          const restore = shadowOrdinaryExport(session, target, kind === "fake"
            ? () => stale
            : () => { throw new Error("forged post-capture ordinary export failure"); });
          try {
            // No canonical state changed after capture. The source fence must
            // therefore remain current without consulting this public API.
            expect(sourceState.isPreActionSnapshotCurrent()).toBe(true);
          } finally {
            restore();
          }
        });
      } finally {
        session.close();
      }
    });
  }
}
