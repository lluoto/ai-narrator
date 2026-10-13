import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { KPAgent } from "../agent/kp-agent";
import { GameSession, ORDINARY_OPENING_FALLBACK } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import type { LLMLike } from "../llm/client";
import type { OpeningProviderFailure, ProviderFallbackProof } from "./ordinary-session-opening-provider-fallback-child";

const CONFIG = { apiKey: "sk-opening-response-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const SESSION_ID = "12345678-1234-4123-8123-123456789aae";
const auth: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "ordinary-opening-response-owner" },
});
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createRuntime(
  opening: (signal?: AbortSignal) => Promise<string>,
  ordinarySnapshots?: OrdinarySessionSnapshotStore,
): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  return {
    registry,
    dependencies: {
      registry,
      ...(ordinarySnapshots ? { ordinarySnapshots } : {}),
      ordinaryIntentPolicy: "development_fallback",
      generateSessionId: () => SESSION_ID,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, {
          ...runtimeDependencies,
          ...(sessionIntentClient ? { sessionIntentClient } : {}),
        });
        session.getOpeningScene = opening;
        return session;
      },
    },
  };
}

async function create(
  root: string,
  dependencies: SessionRuntimeDependencies,
  signal?: AbortSignal,
): Promise<Response> {
  return handleRequest(new Request("http://ordinary-opening.test/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archetype: "detective", characterName: "Ada" }),
    ...(signal ? { signal } : {}),
  }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
  undefined, undefined, undefined, { mode: "required" }, dependencies);
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ordinary-opening-response-"));
  roots.add(value);
  return value;
}

function closeAll(registry: Map<string, GameSession>): void {
  for (const session of registry.values()) session.close();
}

async function runProviderFallbackProof(
  failure: OpeningProviderFailure = "http_500",
): Promise<ProviderFallbackProof> {
  const worker = new Worker(
    new URL("./ordinary-session-opening-provider-fallback-child.ts", import.meta.url).href,
    { type: "module" },
  );
  try {
    return await new Promise<ProviderFallbackProof>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error("provider fallback worker timed out"));
      }, 15_000);
      const finish = (result: ProviderFallbackProof | Error) => {
        clearTimeout(timeout);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      worker.onmessage = (event: MessageEvent<{ status: "ok"; proof: ProviderFallbackProof } | { status: "error"; message: string }>) => {
        if (event.data.status === "ok") finish(event.data.proof);
        else finish(new Error(event.data.message));
      };
      worker.onerror = (event: ErrorEvent) => finish(new Error(event.message || "provider fallback worker failed"));
      worker.postMessage(failure);
    });
  } finally {
    worker.terminate();
  }
}

describe("ordinary session opening public response sanitization", () => {
  test("keeps an HTTP 500 opening to one real LLMClient POST while persisting its safe fallback", async () => {
    const proof = await runProviderFallbackProof();
    const body = JSON.parse(proof.bodyText) as { opening?: string; openingStatus?: string; openingCode?: string };
    const observed = `${proof.bodyText}\n${proof.warnings.join("\n")}`;

    expect(proof.status).toBe(201);
    expect(proof.creationFetchCalls).toEqual([
      { method: "POST", url: "https://provider.invalid/v1/chat/completions" },
    ]);
    expect(proof.registrySize).toBe(1);
    expect(proof.snapshotOccupied).toBe(true);
    expect(body).toMatchObject({
      opening: ORDINARY_OPENING_FALLBACK,
      openingStatus: "fallback",
      openingCode: "ORDINARY_OPENING_UNAVAILABLE",
    });
    expect(proof.directOpening).toBe(ORDINARY_OPENING_FALLBACK);
    expect(observed).not.toContain("provider-secret");
    expect(observed).not.toContain("provider.invalid");
    expect(observed).not.toContain("request-id");
    expect(observed).not.toContain("body=token");
  });

  test("treats a provider AbortError as one failed opening POST and persists the same safe fallback", async () => {
    const proof = await runProviderFallbackProof("abort_error");
    const body = JSON.parse(proof.bodyText) as { opening?: string; openingStatus?: string; openingCode?: string };

    expect(proof.creationFetchCalls).toEqual([
      { method: "POST", url: "https://provider.invalid/v1/chat/completions" },
    ]);
    expect(proof.status).toBe(201);
    expect(proof.registrySize).toBe(1);
    expect(proof.snapshotOccupied).toBe(true);
    expect(body).toMatchObject({
      opening: ORDINARY_OPENING_FALLBACK,
      openingStatus: "fallback",
      openingCode: "ORDINARY_OPENING_UNAVAILABLE",
    });
    expect(proof.directOpening).toBe(ORDINARY_OPENING_FALLBACK);
  });

  test("keeps arbitrary KP provider failure details out of the fallback warning", async () => {
    const marker = "kp-secret https://provider.invalid/path request-id=secret body=token";
    const provider: LLMLike = { chat: async () => { throw new Error(marker); } };
    const warnings: string[] = [];
    const savedWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
    try {
      const result = await new KPAgent({
        scene_description: "archive",
        scene_elements: [],
        current_phase: "exploration",
        style: "standard",
        plot_nodes: [],
      }, provider).describeScene();

      expect(result).toBeTruthy();
      expect(warnings.join("\n")).not.toContain(marker);
      expect(warnings.join("\n")).not.toContain("provider.invalid");
    } finally {
      console.warn = savedWarn;
    }
  });

  test("uses the factory's string opening seam once without a bypass provider request", async () => {
    const workspace = root();
    const savedFetch = globalThis.fetch;
    let factoryCalls = 0;
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "bypassed provider opening" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const current = createRuntime(async () => {
      factoryCalls++;
      return "factory seam opening";
    });
    try {
      const response = await create(workspace, current.dependencies);
      const body = await response.json() as { opening?: string; openingStatus?: string; openingCode?: string };

      expect(response.status).toBe(201);
      expect(body).toMatchObject({ opening: "factory seam opening", openingStatus: "ready" });
      expect(body).not.toHaveProperty("openingCode");
      expect(factoryCalls).toBe(1);
      expect(providerCalls).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
      closeAll(current.registry);
    }
  });

  test("returns a safe 201 fallback without reflecting an opening error's secret body, URL, stack, or cause", async () => {
    const workspace = root();
    const marker = "opening-secret https://provider.invalid/v1/chat model=private path=C:/secret request-id=abc body=token";
    const cause = new Error(marker);
    const error = new Error(marker, { cause });
    error.stack = `stack ${marker}`;
    const current = createRuntime(async () => { throw error; });
    try {
      const response = await create(workspace, current.dependencies);
      const text = await response.text();
      const body = JSON.parse(text) as { opening: string; openingStatus?: string; openingCode?: string };

      expect(response.status).toBe(201);
      expect(body.opening).toBe("夜幕降临，故事由此开始…");
      expect(body.openingStatus).toBe("fallback");
      expect(body.openingCode).toBe("ORDINARY_OPENING_UNAVAILABLE");
      expect(text).not.toContain(marker);
      expect(text).not.toContain("provider.invalid");
      expect(text).not.toContain("request-id");
      expect(current.registry.size).toBe(1);
    } finally {
      closeAll(current.registry);
    }
  });

  test("keeps successful opening text and marks it ready without an opening code", async () => {
    const workspace = root();
    const current = createRuntime(async () => "The study door stands open.");
    try {
      const response = await create(workspace, current.dependencies);
      const body = await response.json() as { opening: string; openingStatus?: string; openingCode?: string };

      expect(response.status).toBe(201);
      expect(body).toMatchObject({ opening: "The study door stands open.", openingStatus: "ready" });
      expect(body).not.toHaveProperty("openingCode");
    } finally {
      closeAll(current.registry);
    }
  });

  test("treats an AbortError without a genuinely aborted request signal as a persisted 201 fallback", async () => {
    const workspace = root();
    const current = createRuntime(async () => { throw new DOMException("provider labelled this AbortError", "AbortError"); });
    try {
      const response = await create(workspace, current.dependencies);
      const body = await response.json() as { openingStatus?: string; openingCode?: string };

      expect(response.status).toBe(201);
      expect(body).toMatchObject({ openingStatus: "fallback", openingCode: "ORDINARY_OPENING_UNAVAILABLE" });
      expect(current.registry.size).toBe(1);
    } finally {
      closeAll(current.registry);
    }
  });

  test("a genuinely aborted request remains 408 and publishes neither a snapshot nor a live session", async () => {
    const workspace = root();
    const entered = deferred<void>();
    const controller = new AbortController();
    const current = createRuntime((signal) => new Promise<string>((_resolve, reject) => {
      entered.resolve();
      signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    try {
      const pending = create(workspace, current.dependencies, controller.signal);
      await entered.promise;
      controller.abort();
      const response = await pending;
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(workspace, "sessions", "ordinary-snapshots") });

      expect(response.status).toBe(408);
      expect(await response.json()).toMatchObject({ error: { stage: "request", code: "REQUEST_ABORTED" } });
      expect(current.registry.size).toBe(0);
      expect(snapshots.isOccupied(SESSION_ID)).toBe(false);
      expect(new SessionNamespaceCoordinator(join(workspace, "sessions")).read(SESSION_ID))
        .toMatchObject({ state: "abandoned", reasonCode: "CREATE_REQUEST_ABORTED" });
    } finally {
      closeAll(current.registry);
    }
  });

  test("a fallback opening still waits for generation-zero persistence and preserves its failure response", async () => {
    const workspace = root();
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(workspace, "sessions", "ordinary-snapshots") });
    snapshots.save = (() => ({
      status: "refused",
      code: "ORDINARY_SNAPSHOT_STORAGE_FAILED",
      message: "simulated persistence refusal",
      sessionId: SESSION_ID,
    })) as OrdinarySessionSnapshotStore["save"];
    const current = createRuntime(async () => { throw new Error("opening provider failure"); }, snapshots);
    try {
      const response = await create(workspace, current.dependencies);
      const body = await response.json() as { error?: { code?: string } };

      expect(response.status).toBe(500);
      expect(body).toMatchObject({ error: { code: "ORDINARY_SESSION_PERSISTENCE_UNAVAILABLE" } });
      expect(current.registry.size).toBe(0);
      expect(snapshots.isOccupied(SESSION_ID)).toBe(false);
    } finally {
      closeAll(current.registry);
    }
  });
});
