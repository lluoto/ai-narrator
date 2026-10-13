import { describe, expect, test } from "bun:test";

type OrdinaryOpeningAbortScenario = "abort" | "race";
type OrdinaryOpeningAbortProof = {
  status: number;
  body: unknown;
  providerSignalAborted: boolean;
  registrySize: number;
  snapshotOccupied: boolean;
  reservation: unknown;
  stagingClean?: boolean;
};
type WorkerReply =
  | { status: "ok"; proof: OrdinaryOpeningAbortProof }
  | { status: "error"; message: string };

/**
 * The server opening contract deliberately exercises a real LLMClient request,
 * whose only transport seam is globalThis.fetch. Run the probe in a Worker so
 * another test's fake provider cannot hide an abort or prevent this provider
 * from being reached.
 */
async function runIsolatedOpeningAbortProof(
  scenario: OrdinaryOpeningAbortScenario,
): Promise<OrdinaryOpeningAbortProof> {
  const worker = new Worker(
    new URL("./ordinary-session-opening-abort-child.ts", import.meta.url).href,
    { type: "module" },
  );
  try {
    return await new Promise<OrdinaryOpeningAbortProof>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error(`ordinary opening abort worker timed out: ${scenario}`));
      }, 10_000);
      const finish = (value: OrdinaryOpeningAbortProof | Error) => {
        clearTimeout(timeout);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (event.data.status === "ok") finish(event.data.proof);
        else finish(new Error(event.data.message));
      };
      worker.onerror = (event: ErrorEvent) => finish(new Error(event.message || "ordinary opening abort worker failed"));
      worker.postMessage(scenario);
    });
  } finally {
    worker.terminate();
  }
}

describe("ordinary session opening request cancellation", () => {
  test("an abort after JSON consumption cancels the real opening provider and cannot publish the staged ordinary session", async () => {
    const proof = await runIsolatedOpeningAbortProof("abort");

    expect(proof.status).toBe(408);
    expect(proof.body).toMatchObject({ error: { stage: "request", code: "REQUEST_ABORTED" } });
    expect(proof.providerSignalAborted).toBe(true);
    expect(proof.registrySize).toBe(0);
    expect(proof.snapshotOccupied).toBe(false);
    expect(proof.reservation).toMatchObject({ kind: "ordinary", state: "abandoned", reasonCode: "CREATE_REQUEST_ABORTED" });
    expect(proof.stagingClean).toBe(true);
  });

  test("a completion racing with disconnect still cannot cross the post-opening publication gate", async () => {
    const proof = await runIsolatedOpeningAbortProof("race");

    expect(proof.status).toBe(408);
    expect(proof.body).toMatchObject({ error: { stage: "request", code: "REQUEST_ABORTED" } });
    expect(proof.providerSignalAborted).toBe(true);
    expect(proof.registrySize).toBe(0);
    expect(proof.snapshotOccupied).toBe(false);
    expect(proof.reservation).toMatchObject({ kind: "ordinary", state: "abandoned", reasonCode: "CREATE_REQUEST_ABORTED" });
  });
});
