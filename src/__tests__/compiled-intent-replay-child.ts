import { CompiledIntentReplayStore } from "../api/compiled-intent-replay";
import type { CompiledIntentReplayIdentity } from "../api/game-session";

if (import.meta.main) {
  const [root, encodedIdentity] = process.argv.slice(2);
  try {
    if (!root || !encodedIdentity) throw new Error("compiled intent replay child requires root and identity");
    const identity = JSON.parse(encodedIdentity) as CompiledIntentReplayIdentity;
    const result = new CompiledIntentReplayStore(root).save(identity, { kind: "no_match", mechanismKeys: [] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "stored") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
