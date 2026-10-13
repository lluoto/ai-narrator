import { writeFileSync } from "node:fs";
import { GameSession } from "../../api/game-session";

const marker = process.env.__SERVER_RUNTIME_CONFIG_CLEANUP_MARKER;
const originalClose = GameSession.prototype.close;
GameSession.prototype.close = function closeWithCleanupMarker(...args: Parameters<GameSession["close"]>): ReturnType<GameSession["close"]> {
  if (marker) writeFileSync(marker, "expired session closed", "utf8");
  return originalClose.apply(this, args);
};

const originalSetInterval = globalThis.setInterval;
let injectedCleanupTick = false;
globalThis.setInterval = ((...parameters: Parameters<typeof setInterval>) => {
  const [callback, delay, ...args] = parameters;
  const timer = originalSetInterval(...parameters);
  // Only accelerate the production cleanup cadence under test. Other timers
  // must retain their ordinary scheduling semantics in the real main process.
  if (!injectedCleanupTick && delay === 5 * 60_000 && typeof callback === "function") {
    injectedCleanupTick = true;
    queueMicrotask(() => callback(...args));
  }
  return timer;
}) as typeof setInterval;
