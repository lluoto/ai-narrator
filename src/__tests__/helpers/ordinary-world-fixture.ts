import type { LLMConfig } from "../../config";
import { GameSession } from "../../api/game-session";
import { ordinaryGameSessionSnapshotHash } from "../../api/ordinary-game-session-snapshot";
import { WorldStateManager } from "../../state/world-state-manager";

const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

/**
 * Prepare a portable ordinary-session world through the same signed restore
 * boundary used by recovery.  It is intentionally test-only: production
 * GameSession never exposes its canonical WorldStateManager for fixture setup.
 */
export function restoreSignedOrdinaryWorld(
  target: GameSession,
  llmConfig: LLMConfig,
  configure: (world: WorldStateManager) => void,
  snapshotSource?: GameSession,
): void {
  const source = snapshotSource ?? new GameSession(
    target.id,
    "cosmic-horror",
    llmConfig,
    "investigator",
    "Fixture Ada",
    undefined,
    undefined,
    undefined,
    "preferred",
    TRANSIENT_RUNTIME,
  );
  const ownsSource = snapshotSource === undefined;
  const sidecarWorld = new WorldStateManager(":memory:");
  try {
    const portable = structuredClone(source.exportOrdinarySessionSnapshot());
    sidecarWorld.restoreSnapshot(portable.world);
    configure(sidecarWorld);
    const { snapshotHash: _oldHash, ...unsigned } = portable;
    const payload = {
      ...unsigned,
      world: sidecarWorld.exportSnapshot(),
    };
    target.restoreOrdinarySessionSnapshot({
      ...payload,
      snapshotHash: ordinaryGameSessionSnapshotHash(payload),
    });
  } finally {
    sidecarWorld.close();
    if (ownsSource) source.close();
  }
}
