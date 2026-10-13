import { existsSync } from "fs";
import { CareerFileStore } from "../character/career-file";
import type { CareerEntry } from "../character/career";

const PREFIX = "@@career-file-concurrency@@";

function emit(value: Record<string, unknown>): void {
  console.log(`${PREFIX}${JSON.stringify(value)}`);
}

function waitForRelease(releasePath: string): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  while (!existsSync(releasePath)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("career concurrency child timed out waiting for release");
    Atomics.wait(signal, 0, 0, Math.min(remaining, 25));
  }
}

function entry(characterName: string, id: string, narrative: string): CareerEntry {
  return {
    id,
    characterName,
    moduleId: "concurrency-module",
    moduleName: "Concurrency Module",
    completedAt: "2026-09-29T00:00:00.000Z",
    endingId: "completed",
    endingName: "Completed",
    sanChange: 0,
    cmChange: 0,
    reputationChange: 0,
    skillChanges: [],
    rewardIds: [],
    narrative,
  };
}

if (import.meta.main) {
  const [root, characterName, id, narrative, mode, releasePath] = process.argv.slice(2);
  try {
    if (!root || !characterName || !id || !narrative || !mode || !releasePath) {
      throw new Error("career concurrency child requires root, identity, entry, mode, and release path");
    }
    const store = new CareerFileStore(root);
    if (mode === "pause" || mode === "throw") {
      const testStore = store as unknown as { atomicWrite: (...args: unknown[]) => void };
      const realAtomicWrite = testStore.atomicWrite.bind(store);
      testStore.atomicWrite = (...args: unknown[]) => {
        emit({ event: "ready", id });
        if (mode === "throw") throw new Error("forced test wrapper failure");
        waitForRelease(releasePath);
        realAtomicWrite(...args);
      };
    }
    store.addEntry(entry(characterName, id, narrative));
    emit({ event: "success", id });
  } catch (error) {
    emit({ event: "error", id, message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally { /* Instance-local test wrapper is discarded with this child. */ }
}
