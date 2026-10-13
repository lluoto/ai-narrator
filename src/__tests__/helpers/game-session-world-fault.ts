import type { GameSession } from "../../api/game-session";
import { WorldStateManager } from "../../state/world-state-manager";

/**
 * Test-only fault injection for one GameSession's hidden raw world manager.
 * The facade deliberately has no injection seam. Capture the private raw
 * receiver through one synchronous read-only export; test setup leaves the
 * portable world unchanged before its failure path runs.
 */
export function patchGameSessionWorldMethod(
  session: GameSession,
  method: string,
  onTarget: (original: (...args: any[]) => unknown, receiver: WorldStateManager, args: any[]) => unknown,
): () => void {
  const prototype = WorldStateManager.prototype as unknown as Record<string, (...args: any[]) => unknown>;
  const original = prototype[method];
  if (typeof original !== "function") throw new Error(`unknown WorldStateManager method: ${method}`);

  const targets = new WeakSet<WorldStateManager>();
  const originalExportSnapshot = prototype.exportSnapshot;
  const captureTargetWorld = function captureTargetWorld(this: WorldStateManager, ...args: any[]): unknown {
    targets.add(this);
    return originalExportSnapshot.apply(this, args);
  };
  prototype.exportSnapshot = captureTargetWorld;
  try {
    session.world.exportSnapshot();
  } finally {
    if (prototype.exportSnapshot === captureTargetWorld) {
      prototype.exportSnapshot = originalExportSnapshot;
    }
  }

  let active = true;
  const patched = function patchTargetWorld(this: WorldStateManager, ...args: any[]): unknown {
    if (active && targets.has(this)) return onTarget(original, this, args);
    return original.apply(this, args);
  };
  prototype[method] = patched;

  return () => {
    if (!active) return;
    active = false;
    if (prototype[method] === patched) prototype[method] = original;
  };
}

/**
 * Test-fixture-only scene activation. GameSession deliberately has no public
 * scene writer: real moves must go through act(). A few fixtures need to
 * arrange an already-registered scene without exercising unrelated intent
 * parsing, so capture that session's raw world synchronously through its
 * read-only facade and use the world-level registration contract directly.
 */
export function activateRegisteredGameSessionSceneForTest(session: GameSession, sceneId: string): boolean {
  const prototype = WorldStateManager.prototype as unknown as Record<string, (...args: any[]) => unknown>;
  const originalExportSnapshot = prototype.exportSnapshot;
  let target: WorldStateManager | undefined;
  const captureTargetWorld = function captureTargetWorld(this: WorldStateManager, ...args: any[]): unknown {
    target = this;
    return originalExportSnapshot.apply(this, args);
  };

  prototype.exportSnapshot = captureTargetWorld;
  try {
    session.world.exportSnapshot();
  } finally {
    if (prototype.exportSnapshot === captureTargetWorld) {
      prototype.exportSnapshot = originalExportSnapshot;
    }
  }

  if (!target) throw new Error("could not capture GameSession test world");
  if (!target.getScene(sceneId)) return false;
  return target.setActiveScene(sceneId);
}
