import type { LLMConfig } from "../../config";
import { GameSession } from "../../api/game-session";
import { ordinaryGameSessionSnapshotHash } from "../../api/ordinary-game-session-snapshot";
import { CompanionManager } from "../../combat/companion-manager";
import { WorldStateManager } from "../../state/world-state-manager";
import type { CompanionConfig } from "../../types";

/** A portable fixture installed through the same signed restore boundary as production recovery. */
export const ORDINARY_COMPANION_FIXTURE: CompanionConfig = {
  id: "ordinary-known-companion",
  name: "老李",
  type: "npc",
  behavior: "support",
  hp: 10,
  maxHp: 10,
  ac: 10,
  skills: { fight: 55 },
  damageDice: "1d4",
  inventory: ["flashlight"],
  traits: { courage: 5, aggression: 2, caution: 6, loyalty: 7, cruelty: 1 },
};

/**
 * Install a companion only by composing real WorldStateManager and
 * CompanionManager snapshots, then re-signing the ordinary-session envelope.
 * Production GameSession never gets a test-only raw write seam.
 */
export function restoreSignedOrdinaryCompanion(
  target: GameSession,
  llmConfig: LLMConfig,
  config: CompanionConfig = ORDINARY_COMPANION_FIXTURE,
  snapshotSource?: GameSession,
): void {
  const source = snapshotSource ?? new GameSession(target.id, "cosmic-horror", llmConfig, "investigator", "Fixture Ada");
  const ownsSource = snapshotSource === undefined;
  const sidecarWorld = new WorldStateManager(":memory:");
  try {
    const portable = structuredClone(source.exportOrdinarySessionSnapshot());
    sidecarWorld.restoreSnapshot(portable.world);
    const manager = new CompanionManager();
    manager.recruit(structuredClone(config), sidecarWorld, "tavern");
    const { snapshotHash: _oldHash, ...unsigned } = portable;
    const payload = {
      ...unsigned,
      world: sidecarWorld.exportSnapshot(),
      companionManager: manager.exportSnapshot(),
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
