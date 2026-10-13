import { describe, expect, it } from "bun:test";

type OverrideScenario = "disabled-opening" | "template-opening" | "explicit-opening" | "registry";

type OverrideProof = {
  fetchCalls: string[];
  opening?: string;
  registered?: boolean;
  dialogue?: boolean;
};

type WorkerReply =
  | { status: "ok"; proof: OverrideProof }
  | { status: "error"; message: string };

/**
 * The production contract reads process.env at construction time, and the
 * transport is globalThis.fetch. A Worker keeps this proof's deliberately
 * valid key, offline override, fake transport, and static LLM breaker out of
 * unrelated HTTP-opening tests that run in the parent Bun test isolate.
 */
async function runIsolatedOverrideProof(scenario: OverrideScenario): Promise<OverrideProof> {
  const worker = new Worker(
    new URL("./game-session-llm-override-opening-child.ts", import.meta.url).href,
    { type: "module" },
  );
  try {
    return await new Promise<OverrideProof>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error(`LLM override worker timed out: ${scenario}`));
      }, 10_000);
      const finish = (value: OverrideProof | Error) => {
        clearTimeout(timeout);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (event.data.status === "ok") finish(event.data.proof);
        else finish(new Error(event.data.message));
      };
      worker.onerror = (event: ErrorEvent) => finish(new Error(event.message || "LLM override worker failed"));
      worker.postMessage(scenario);
    });
  } finally {
    worker.terminate();
  }
}

describe("GameSession explicit offline LLM overrides", () => {
  it("keeps a default-config opening offline for LLM_DISABLED=true despite a usable key", async () => {
    expect((await runIsolatedOverrideProof("disabled-opening")).fetchCalls).toHaveLength(0);
  });

  it("keeps a default-config opening offline for LLM_MODE=template despite a usable key", async () => {
    expect((await runIsolatedOverrideProof("template-opening")).fetchCalls).toHaveLength(0);
  });

  it("keeps an explicitly supplied valid config provider-enabled when no override is set", async () => {
    const proof = await runIsolatedOverrideProof("explicit-opening");
    expect(proof.opening).toBe("provider opening scene");
    expect(proof.fetchCalls).toEqual(["https://explicit-session-config.invalid/v1/chat/completions"]);
  });

  it("shares the offline runtime LLM with registered NPC agents", async () => {
    const proof = await runIsolatedOverrideProof("registry");
    expect(proof.registered).toBe(true);
    expect(proof.dialogue).toBe(true);
    expect(proof.fetchCalls).toHaveLength(0);
  });
});
