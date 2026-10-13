import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { LLMClient } from "../llm/client";

export const PROVIDER_SECRET = "provider-secret https://provider.invalid/v1/chat model=private path=C:/secret request-id=req-secret body=token";

export type OpeningProviderFailure = "http_500" | "abort_error";
export type ProviderFetchCall = Readonly<{ method: string | undefined; url: string }>;

export type ProviderFallbackProof = Readonly<{
  status: number;
  bodyText: string;
  warnings: readonly string[];
  fetchCalls: readonly ProviderFetchCall[];
  /** Only calls issued while the HTTP creation request was in flight. */
  creationFetchCalls: readonly ProviderFetchCall[];
  /** A fallback is still a successfully durable ordinary-session creation. */
  registrySize: number;
  snapshotOccupied: boolean;
  directOpening: string;
}>;

const CONFIG = {
  apiKey: "sk-opening-provider-fallback-test",
  baseUrl: "https://provider.invalid/v1",
  model: "private-opening-model",
  maxTokens: 1,
  temperature: 0,
};
const SESSION_ID = "12345678-1234-4123-8123-123456789aaf";
const auth: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "ordinary-opening-provider-owner" },
});

function createRuntime(ordinarySnapshots: OrdinarySessionSnapshotStore): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  return {
    registry,
    dependencies: {
      registry,
      ordinarySnapshots,
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
    },
  };
}

function restoreEnvironment(saved: Record<"LLM_DISABLED" | "LLM_MODE", string | undefined>): void {
  for (const key of ["LLM_DISABLED", "LLM_MODE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

/** Isolated worker proof: actual LLMClient failures reach ordinary HTTP creation. */
export async function runProviderFallbackProof(
  failure: OpeningProviderFailure = "http_500",
): Promise<ProviderFallbackProof> {
  const savedEnvironment = {
    LLM_DISABLED: process.env.LLM_DISABLED,
    LLM_MODE: process.env.LLM_MODE,
  };
  const savedFetch = globalThis.fetch;
  const savedWarn = console.warn;
  const warnings: string[] = [];
  const fetchCalls: ProviderFetchCall[] = [];
  const root = mkdtempSync(join(tmpdir(), "ordinary-opening-provider-fallback-"));
  const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
  const current = createRuntime(ordinarySnapshots);

  delete process.env.LLM_DISABLED;
  delete process.env.LLM_MODE;
  LLMClient.resetDefeat();
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ method: init?.method, url: String(input) });
    if (failure === "abort_error") {
      // This is a provider-side transport failure, not a cancelled HTTP request.
      throw new DOMException("simulated provider timeout", "AbortError");
    }
    return new Response(JSON.stringify({ error: { message: PROVIDER_SECRET, request_id: PROVIDER_SECRET } }), {
      status: 500,
      headers: { "Content-Type": "application/json", "X-Request-Id": PROVIDER_SECRET },
    });
  }) as typeof fetch;

  try {
    const response = await handleRequest(new Request("http://ordinary-opening.test/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archetype: "detective", characterName: "Ada" }),
    }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
    undefined, undefined, undefined, { mode: "required" }, current.dependencies);
    const bodyText = await response.text();
    const creationFetchCalls = [...fetchCalls];
    const registrySize = current.registry.size;
    const snapshotOccupied = ordinarySnapshots.isOccupied(SESSION_ID);

    // Direct/CLI callers retain the legacy string API even though HTTP needs a richer result.
    const direct = new GameSession("ordinary-opening-provider-direct", "cosmic-horror", CONFIG);
    let directOpening: string;
    try {
      directOpening = await direct.getOpeningScene();
    } finally {
      direct.close();
    }

    return Object.freeze({
      status: response.status,
      bodyText,
      warnings: Object.freeze([...warnings]),
      fetchCalls: Object.freeze([...fetchCalls]),
      creationFetchCalls: Object.freeze(creationFetchCalls),
      registrySize,
      snapshotOccupied,
      directOpening,
    });
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
    globalThis.fetch = savedFetch;
    console.warn = savedWarn;
    LLMClient.resetDefeat();
    restoreEnvironment(savedEnvironment);
  }
}

type WorkerScope = {
  postMessage(message: { status: "ok"; proof: ProviderFallbackProof } | { status: "error"; message: string }): void;
  addEventListener(type: "message", listener: (event: MessageEvent<OpeningProviderFailure | undefined>) => void | Promise<void>): void;
};

const workerScope = globalThis as typeof globalThis & Partial<WorkerScope>;
if (typeof workerScope.postMessage === "function" && typeof workerScope.addEventListener === "function") {
  const scope = workerScope as typeof globalThis & WorkerScope;
  scope.addEventListener("message", async (event) => {
    try {
      scope.postMessage({ status: "ok", proof: await runProviderFallbackProof(event.data) });
    } catch (error) {
      scope.postMessage({ status: "error", message: error instanceof Error ? error.message : "provider fallback child failed" });
    }
  });
}
