import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { NPCStore } from "../db";
import { LLMClient } from "../llm/client";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";

type RuntimeLifecycleKey =
  | "hasSessionOwnedNpcStore"
  | "npcStoreClosed"
  | "lifecycleRevision"
  | "directActionFailStopped";

type ReflectionMode = "assignment" | "definition";

const sessions: GameSession[] = [];

afterEach(() => {
  while (sessions.length > 0) {
    try { sessions.pop()!.close(); } catch { /* the test already closed its authority */ }
  }
});

function fresh(label: string, runtimeDependencies: ConstructorParameters<typeof GameSession>[9] = {}): GameSession {
  const session = new GameSession(
    `lifecycle-private-authority-${label}-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
    runtimeDependencies,
  );
  sessions.push(session);
  return session;
}

function freshProviderOpeningSession(label: string): GameSession {
  const session = new GameSession(
    `lifecycle-private-authority-${label}-${crypto.randomUUID()}`,
    "cosmic-horror",
    {
      apiKey: "sk-opening-lifecycle-test",
      baseUrl: "https://opening-lifecycle-test.invalid/v1",
      model: "opening-lifecycle-test-model",
      maxTokens: 32,
      temperature: 0,
    },
  );
  sessions.push(session);
  return session;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function providerCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function withProviderEnabled<T>(run: () => Promise<T>): Promise<T> {
  const previousDisabled = process.env.LLM_DISABLED;
  const previousMode = process.env.LLM_MODE;
  delete process.env.LLM_DISABLED;
  delete process.env.LLM_MODE;
  try {
    return await run();
  } finally {
    if (previousDisabled === undefined) delete process.env.LLM_DISABLED;
    else process.env.LLM_DISABLED = previousDisabled;
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  }
}

/** Attempt to recreate the historic TypeScript-private instance fields by name. */
function reflectLifecycleAuthority(
  session: GameSession,
  mode: ReflectionMode,
  values: Partial<Record<RuntimeLifecycleKey, boolean | number>>,
): void {
  const receiver = session as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (mode === "assignment") {
      expect(Reflect.set(receiver, key, value)).toBe(true);
    } else {
      Object.defineProperty(receiver, key, { value, configurable: true, enumerable: true, writable: true });
    }
  }
}

function closedValues(): Record<RuntimeLifecycleKey, boolean | number> {
  return {
    hasSessionOwnedNpcStore: true,
    npcStoreClosed: false,
    lifecycleRevision: 0,
    directActionFailStopped: false,
  };
}

describe("GameSession lifecycle authority", () => {
  test("does not acknowledge or observe an opening completed after close", () => withProviderEnabled(async () => {
    const session = freshProviderOpeningSession("opening-close-success");
    const previousFetch = globalThis.fetch;
    const requestStarted = deferred<void>();
    const response = deferred<Response>();
    let observations = 0;
    LLMClient.resetDefeat();
    globalThis.fetch = (() => {
      requestStarted.resolve();
      return response.promise;
    }) as unknown as typeof fetch;
    try {
      const opening = session.getOpeningScene(undefined, () => { observations++; });
      await requestStarted.promise;
      session.close();
      response.resolve(providerCompletion("STALE OPENING MUST NOT LEAK"));

      await expect(opening).rejects.toThrow("closed GameSession cannot accept actions");
      expect(observations).toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
      LLMClient.resetDefeat();
    }
  }));

  test("does not turn a provider failure after close into an opening fallback", () => withProviderEnabled(async () => {
    const session = freshProviderOpeningSession("opening-close-error");
    const previousFetch = globalThis.fetch;
    const requestStarted = deferred<void>();
    const response = deferred<Response>();
    let observations = 0;
    LLMClient.resetDefeat();
    globalThis.fetch = (() => {
      requestStarted.resolve();
      return response.promise;
    }) as unknown as typeof fetch;
    try {
      const opening = session.getOpeningScene(undefined, () => { observations++; });
      await requestStarted.promise;
      session.close();
      response.reject(new Error("provider failed after session close"));

      await expect(opening).rejects.toThrow("closed GameSession cannot accept actions");
      expect(observations).toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
      LLMClient.resetDefeat();
    }
  }));

  for (const mode of ["assignment", "definition"] as const) {
    test(`a closed session remains closed after same-name reflective ${mode}`, async () => {
      const actionSession = fresh(`${mode}-action`);
      actionSession.close();
      reflectLifecycleAuthority(actionSession, mode, closedValues());
      await expect(actionSession.act("/help")).rejects.toThrow("closed GameSession cannot accept actions");

      const exportSession = fresh(`${mode}-export`);
      exportSession.close();
      reflectLifecycleAuthority(exportSession, mode, closedValues());
      expect(() => exportSession.exportOrdinarySessionSnapshot()).toThrow("closed GameSession cannot be exported");

      const restoreSession = fresh(`${mode}-restore`);
      const snapshot = restoreSession.exportOrdinarySessionSnapshot();
      restoreSession.close();
      reflectLifecycleAuthority(restoreSession, mode, closedValues());
      expect(() => restoreSession.restoreOrdinarySessionSnapshot(snapshot)).toThrow(
        "closed GameSession cannot restore an ordinary-session snapshot",
      );
    });
  }

  for (const mode of ["assignment", "definition"] as const) {
    test(`a real direct-action failure remains fail-stopped after latch ${mode}`, async () => {
      const session = fresh(`fail-stop-${mode}`);
      const restoreFault = patchGameSessionWorldMethod(session, "setPlayerSanity", () => {
        throw new Error("lifecycle authority test persistence fault");
      });
      try {
        await expect(session.act("/roll 1d6")).rejects.toThrow("lifecycle authority test persistence fault");
      } finally {
        restoreFault();
      }

      reflectLifecycleAuthority(session, mode, { directActionFailStopped: false });
      await expect(session.act("/roll 1d6")).rejects.toThrow(
        "GameSession is unavailable after a prior action failure",
      );
    });
  }

  for (const mode of ["assignment", "definition"] as const) {
    test(`a caller-owned NPCStore survives forged ownership by ${mode}`, async () => {
      const sharedStore = new NPCStore(":memory:");
      const closing = fresh(`shared-closing-${mode}`, { npcStore: sharedStore });
      const surviving = fresh(`shared-surviving-${mode}`, { npcStore: sharedStore });
      try {
        reflectLifecycleAuthority(closing, mode, {
          hasSessionOwnedNpcStore: true,
          npcStoreClosed: false,
          lifecycleRevision: 0,
          directActionFailStopped: false,
        });
        closing.close();

        const result = await surviving.act("加载模组 普瑞米尔的谷仓");
        expect(result.error).toBeUndefined();
        expect(surviving.npcStore.getAllPersonalities().length).toBeGreaterThan(0);
      } finally {
        try { sharedStore.close(); } catch { /* forged legacy ownership may have closed it */ }
      }
    });
  }
});
