import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";

const CONFIG = {
  apiKey: "sk-opening-abort-test",
  baseUrl: "http://opening-abort.invalid/v1",
  model: "offline",
  maxTokens: 16,
  temperature: 0,
};
const auth: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "ordinary-opening-abort-owner" },
});
const SESSION_ID = "12345678-1234-4123-8123-123456789abd";

export type OrdinaryOpeningAbortScenario = "abort" | "race";
export type OrdinaryOpeningAbortProof = {
  status: number;
  body: unknown;
  providerSignalAborted: boolean;
  registrySize: number;
  snapshotOccupied: boolean;
  reservation: unknown;
  stagingClean?: boolean;
};

async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function dependencies(registry: Map<string, GameSession>): SessionRuntimeDependencies {
  return {
    registry,
    ordinaryIntentPolicy: "development_fallback",
    generateSessionId: () => SESSION_ID,
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies }) => new GameSession(
      id,
      ruleset,
      CONFIG,
      archetypeId,
      characterName,
      persona,
      storage,
      access,
      intentPolicy,
      { ...runtimeDependencies, ...(sessionIntentClient ? { sessionIntentClient } : {}) },
    ),
  };
}

export async function runOrdinaryOpeningAbortProof(
  scenario: OrdinaryOpeningAbortScenario,
): Promise<OrdinaryOpeningAbortProof> {
  const root = mkdtempSync(join(tmpdir(), scenario === "abort" ? "ordinary-opening-abort-" : "ordinary-opening-abort-race-"));
  const controller = new AbortController();
  const registry = new Map<string, GameSession>();
  // test-preload defaults every test process to offline. This probe needs an
  // explicitly provider-capable GameSession so it can prove the caller signal
  // reaches its local fake transport; do not inherit that unrelated default.
  const previousLlmDisabled = process.env.LLM_DISABLED;
  const previousLlmMode = process.env.LLM_MODE;
  delete process.env.LLM_DISABLED;
  delete process.env.LLM_MODE;
  const previousFetch = globalThis.fetch;
  let resolveProviderEntered!: () => void;
  const providerEntered = new Promise<void>((resolve) => { resolveProviderEntered = resolve; });
  let releaseProvider!: () => void;
  let providerSettled = false;
  let providerSignal: AbortSignal | undefined;
  let pending: Promise<Response> | undefined;

  globalThis.fetch = ((_: unknown, init?: RequestInit) => {
    providerSignal = init?.signal ?? undefined;
    resolveProviderEntered();
    return new Promise<Response>((resolve, reject) => {
      const settleAbort = () => {
        if (providerSettled) return;
        providerSettled = true;
        if (scenario === "race") {
          resolve(new Response(JSON.stringify({ choices: [{ message: { content: "opening raced with close" } }] }), { status: 200 }));
        } else {
          const error = new Error("opening request cancelled");
          error.name = "AbortError";
          reject(error);
        }
      };
      releaseProvider = () => {
        if (providerSettled) return;
        providerSettled = true;
        resolve(new Response(JSON.stringify({ choices: [{ message: { content: scenario === "race" ? "opening raced with close" : "opening" } }] }), { status: 200 }));
      };
      if (providerSignal?.aborted) settleAbort();
      else providerSignal?.addEventListener("abort", settleAbort, { once: true });
    });
  }) as typeof fetch;

  try {
    pending = handleRequest(new Request("http://test/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archetype: "detective", characterName: "Ada" }),
      signal: controller.signal,
    }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
    undefined, undefined, undefined, { mode: "required" }, dependencies(registry));
    await within(providerEntered, 1_000, "ordinary opening never entered the provider");
    controller.abort();
    const response = await within(
      pending,
      1_000,
      scenario === "race" ? "racing opening completion did not settle the handler" : "opening cancellation did not settle the handler",
    );
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const stagingParent = join(root, "careers", ".ordinary-create-staging");
    return {
      status: response.status,
      body: await response.json(),
      providerSignalAborted: providerSignal?.aborted === true,
      registrySize: registry.size,
      snapshotOccupied: snapshots.isOccupied(SESSION_ID),
      reservation: new SessionNamespaceCoordinator(join(root, "sessions")).read(SESSION_ID),
      ...(scenario === "abort" ? { stagingClean: !existsSync(stagingParent) || readdirSync(stagingParent).length === 0 } : {}),
    };
  } finally {
    controller.abort();
    releaseProvider?.();
    if (pending) await pending.catch(() => undefined);
    globalThis.fetch = previousFetch;
    if (previousLlmDisabled === undefined) delete process.env.LLM_DISABLED;
    else process.env.LLM_DISABLED = previousLlmDisabled;
    if (previousLlmMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousLlmMode;
    for (const session of registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}

type WorkerScope = {
  postMessage(message: { status: "ok"; proof: OrdinaryOpeningAbortProof } | { status: "error"; message: string }): void;
  addEventListener(type: "message", listener: (event: { data: OrdinaryOpeningAbortScenario }) => void | Promise<void>): void;
};

const workerScope = globalThis as typeof globalThis & Partial<WorkerScope>;

if (typeof workerScope.postMessage === "function" && typeof workerScope.addEventListener === "function") {
  const scope = workerScope as typeof globalThis & WorkerScope;
  scope.addEventListener("message", async (event) => {
    try {
      scope.postMessage({ status: "ok", proof: await runOrdinaryOpeningAbortProof(event.data) });
    } catch (error) {
      scope.postMessage({ status: "error", message: error instanceof Error ? error.message : "ordinary opening abort child failed" });
    }
  });
}
