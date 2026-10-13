import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LLMClient } from "../llm/client";

const CONFIG = {
  apiKey: "sk-provider-concurrency",
  baseUrl: "http://llm-provider-concurrency.test/v1",
  model: "concurrency-test-model",
  maxTokens: 16,
  temperature: 0,
};
const MESSAGES = [{ role: "user" as const, content: "hello" }];
const originalFetch = globalThis.fetch;

function within<T>(task: Promise<T>, milliseconds = 30): Promise<T | "pending"> {
  return Promise.race([
    task,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), milliseconds)),
  ]);
}

function completion(content = "ok"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function abortablePendingFetch(onEnter: () => void): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    onEnter();
    return await new Promise<Response>((_resolve, reject) => {
      const rejectAborted = () => {
        const error = new Error("test request aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) rejectAborted();
      else init?.signal?.addEventListener("abort", rejectAborted, { once: true });
    });
  }) as unknown as typeof fetch;
}

async function abortAndSettle(
  controllers: AbortController[],
  tasks: Promise<unknown>[],
): Promise<void> {
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(tasks);
}

async function assertFourCallsCanEnterAfter(
  client: LLMClient,
  endpointRequests: { value: number },
): Promise<void> {
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const tasks = controllers.map((controller) => client.chat(MESSAGES, {
    maxAttempts: 1,
    timeout: 1_000,
    signal: controller.signal,
  }));
  expect(endpointRequests.value).toBe(4);
  await abortAndSettle(controllers, tasks);
}

describe("LLM process-local provider concurrency admission", () => {
  beforeEach(() => { LLMClient.resetDefeat(); });
  afterEach(() => {
    LLMClient.resetDefeat();
    globalThis.fetch = originalFetch;
  });

  test("enforces workload and endpoint caps, then admits a released workload and another endpoint", async () => {
    const controllers = Array.from({ length: 11 }, () => new AbortController());
    let entered = 0;
    let releaseEntered!: () => void;
    const fourEntered = new Promise<void>((resolve) => { releaseEntered = resolve; });
    globalThis.fetch = abortablePendingFetch(() => {
      entered += 1;
      if (entered === 4) releaseEntered();
    });

    const client = new LLMClient(CONFIG);
    const firstFour = controllers.slice(0, 4).map((signal) => client.chat(MESSAGES, {
      workload: "intent",
      maxAttempts: 1,
      timeout: 1_000,
      signal: signal.signal,
    }));
    await fourEntered;
    // resetDefeat() only clears breaker state. Existing in-flight provider
    // leases remain real capacity and must still reject the fifth call.
    LLMClient.resetDefeat();
    const fifth = client.chat(MESSAGES, {
      workload: "intent",
      maxAttempts: 1,
      timeout: 1_000,
      signal: controllers[4]!.signal,
    });

    await expect(within(fifth.then(
      () => ({ code: "resolved" }),
      (error: unknown) => ({ code: (error as { code?: unknown }).code }),
    ))).resolves.toEqual({ code: "admission_limited" });
    expect(entered).toBe(4);

    const narration = controllers.slice(5, 9).map((signal) => client.chat(MESSAGES, {
      workload: "narration",
      maxAttempts: 1,
      timeout: 1_000,
      signal: signal.signal,
    }));
    expect(entered).toBe(8);
    await expect(client.chat(MESSAGES, {
      workload: "default",
      maxAttempts: 1,
      timeout: 1_000,
      signal: controllers[9]!.signal,
    })).rejects.toMatchObject({ code: "admission_limited" });
    expect(entered).toBe(8);

    controllers[0]!.abort();
    await expect(firstFour[0]).rejects.toMatchObject({ code: "timeout" });
    const releasedIntent = client.chat(MESSAGES, {
      workload: "intent",
      maxAttempts: 1,
      timeout: 1_000,
      signal: controllers[10]!.signal,
    });
    expect(entered).toBe(9);

    const otherEndpoint = new LLMClient({ ...CONFIG, baseUrl: "http://llm-provider-concurrency-other.test/v1" });
    const otherController = new AbortController();
    const other = otherEndpoint.chat(MESSAGES, {
      maxAttempts: 1,
      timeout: 1_000,
      signal: otherController.signal,
    });
    expect(entered).toBe(10);

    await abortAndSettle(
      [...controllers.slice(1, 4), ...controllers.slice(5, 9), controllers[10]!],
      [...firstFour.slice(1), ...narration, releasedIntent],
    );
    await abortAndSettle([otherController], [other]);
    await Promise.allSettled([fifth]);
  });

  test("shares a normalized endpoint across API keys and isolates a distinct endpoint", async () => {
    let entered = 0;
    globalThis.fetch = abortablePendingFetch(() => { entered += 1; });
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const shared = Array.from({ length: 4 }, (_unused, index) => new LLMClient({
      ...CONFIG,
      apiKey: `sk-distinct-${index}`,
      baseUrl: "HTTP://LLM-PROVIDER-CONCURRENCY-SHARED.TEST/v1/",
    }).chat(MESSAGES, {
      maxAttempts: 1,
      timeout: 1_000,
      signal: controllers[index]!.signal,
    }));
    expect(entered).toBe(4);

    await expect(new LLMClient({
      ...CONFIG,
      apiKey: "sk-fifth-key",
      baseUrl: "http://llm-provider-concurrency-shared.test/v1?ignored=query",
    }).chat(MESSAGES, { maxAttempts: 1, timeout: 1_000 })).rejects.toMatchObject({
      code: "admission_limited",
      message: "LLM provider concurrency limit reached",
    });
    expect(entered).toBe(4);

    const isolated = new LLMClient({
      ...CONFIG,
      baseUrl: "http://llm-provider-concurrency-shared.test/v2",
    }).chat(MESSAGES, {
      maxAttempts: 1,
      timeout: 1_000,
      signal: controllers[4]!.signal,
    });
    expect(entered).toBe(5);
    await abortAndSettle(controllers, [...shared, isolated]);
  });

  test("keeps one logical chat lease across its retry and releases every terminal chat failure", async () => {
    const endpoint = "http://llm-provider-concurrency-retry.test/v1";
    const retryControllers = Array.from({ length: 5 }, () => new AbortController());
    let entered = 0;
    let retryFetchEntered!: () => void;
    const retryFetchStarted = new Promise<void>((resolve) => { retryFetchEntered = resolve; });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      entered += 1;
      if (entered === 1) return new Response("retry", { status: 503 });
      if (entered === 2) retryFetchEntered();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("test request aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }) as unknown as typeof fetch;
    const client = new LLMClient({ ...CONFIG, baseUrl: endpoint });
    const retried = client.chat(MESSAGES, {
      maxAttempts: 2,
      timeout: 1_000,
      signal: retryControllers[0]!.signal,
    });
    await retryFetchStarted;
    const otherCalls = retryControllers.slice(1, 4).map((controller) => client.chat(MESSAGES, {
      maxAttempts: 1,
      timeout: 1_000,
      signal: controller.signal,
    }));
    expect(entered).toBe(5); // one logical retry plus three other logical calls
    await expect(client.chat(MESSAGES, {
      maxAttempts: 1,
      timeout: 1_000,
      signal: retryControllers[4]!.signal,
    })).rejects.toMatchObject({ code: "admission_limited" });
    expect(entered).toBe(5);
    await abortAndSettle(retryControllers.slice(0, 4), [retried, ...otherCalls]);

    const failures: Array<{
      name: string;
      code: string;
      response: () => Promise<Response>;
    }> = [
      {
        name: "connection",
        code: "connection_failed",
        response: async () => { throw new TypeError("provider connection failed"); },
      },
      {
        name: "timeout",
        code: "timeout",
        response: async () => await new Promise<Response>(() => {}),
      },
      {
        name: "HTTP",
        code: "http_error",
        response: async () => new Response("provider failure", { status: 400 }),
      },
      {
        name: "invalid response",
        code: "invalid_response",
        response: async () => new Response("{", { status: 200 }),
      },
    ];
    for (const [index, failure] of failures.entries()) {
      const failureEndpoint = `http://llm-provider-concurrency-terminal-${index}.test/v1`;
      const failureClient = new LLMClient({ ...CONFIG, baseUrl: failureEndpoint });
      globalThis.fetch = failure.response as unknown as typeof fetch;
      await expect(failureClient.chat(MESSAGES, {
        maxAttempts: 1,
        timeout: 5,
      })).rejects.toMatchObject({ code: failure.code });
      // Connection failure owns breaker state, not an active admission lease.
      // Reset only after that call is settled; it never clears active leases.
      LLMClient.resetDefeat();
      const enteredAfterTerminal = { value: 0 };
      globalThis.fetch = abortablePendingFetch(() => { enteredAfterTerminal.value += 1; });
      await assertFourCallsCanEnterAfter(failureClient, enteredAfterTerminal);
    }
  });

  test("releases stream leases on early return, caller abort, clean EOF, and never admits an uniterated generator", async () => {
    const encoder = new TextEncoder();
    const earlyEndpoint = "http://llm-provider-concurrency-stream-early.test/v1";
    const earlyClient = new LLMClient({ ...CONFIG, baseUrl: earlyEndpoint });
    globalThis.fetch = (async () => {
      let emitted = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"one"}}]}\n\n'));
          }
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const early = earlyClient.chatStream(MESSAGES);
    await expect(early.next()).resolves.toMatchObject({ value: "one", done: false });
    await expect(early.return(undefined)).resolves.toMatchObject({ done: true });
    const afterEarly = { value: 0 };
    globalThis.fetch = abortablePendingFetch(() => { afterEarly.value += 1; });
    await assertFourCallsCanEnterAfter(earlyClient, afterEarly);

    const abortEndpoint = "http://llm-provider-concurrency-stream-abort.test/v1";
    const abortClient = new LLMClient({ ...CONFIG, baseUrl: abortEndpoint });
    const abortController = new AbortController();
    let abortEntered!: () => void;
    const abortStarted = new Promise<void>((resolve) => { abortEntered = resolve; });
    globalThis.fetch = abortablePendingFetch(abortEntered);
    const aborted = abortClient.chatStream(MESSAGES, {
      timeout: 1_000,
      signal: abortController.signal,
    }).next();
    await abortStarted;
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ code: "timeout" });
    const afterAbort = { value: 0 };
    globalThis.fetch = abortablePendingFetch(() => { afterAbort.value += 1; });
    await assertFourCallsCanEnterAfter(abortClient, afterAbort);

    const eofEndpoint = "http://llm-provider-concurrency-stream-eof.test/v1";
    const eofClient = new LLMClient({ ...CONFIG, baseUrl: eofEndpoint });
    globalThis.fetch = (async () => new Response(
      'data: {"choices":[{"delta":{"content":"tail"}}]}\n\n',
      { status: 200 },
    )) as unknown as typeof fetch;
    await expect(collect(eofClient.chatStream(MESSAGES))).resolves.toEqual(["tail"]);
    const afterEof = { value: 0 };
    globalThis.fetch = abortablePendingFetch(() => { afterEof.value += 1; });
    await assertFourCallsCanEnterAfter(eofClient, afterEof);

    const errorEndpoint = "http://llm-provider-concurrency-stream-error.test/v1";
    const errorClient = new LLMClient({ ...CONFIG, baseUrl: errorEndpoint });
    globalThis.fetch = (async () => new Response("data: {\n\n", { status: 200 })) as unknown as typeof fetch;
    await expect(collect(errorClient.chatStream(MESSAGES))).rejects.toMatchObject({ code: "invalid_response" });
    const afterError = { value: 0 };
    globalThis.fetch = abortablePendingFetch(() => { afterError.value += 1; });
    await assertFourCallsCanEnterAfter(errorClient, afterError);

    const lazyClient = new LLMClient({ ...CONFIG, baseUrl: "http://llm-provider-concurrency-stream-lazy.test/v1" });
    const lazy = Array.from({ length: 8 }, () => lazyClient.chatStream(MESSAGES));
    let lazyFetches = 0;
    globalThis.fetch = (async () => {
      lazyFetches += 1;
      return completion("not a stream");
    }) as unknown as typeof fetch;
    await expect(lazyClient.chat(MESSAGES, { maxAttempts: 1 })).resolves.toBe("not a stream");
    expect(lazyFetches).toBe(1);
    expect(lazy).toHaveLength(8);
  });

  test("validates local workload before breaker, and checks breaker before an otherwise-full admission", async () => {
    const endpoint = "http://llm-provider-concurrency-ordering.test/v1";
    const client = new LLMClient({ ...CONFIG, baseUrl: endpoint });
    let entered = 0;
    globalThis.fetch = (async () => {
      entered += 1;
      throw new TypeError("trip default breaker");
    }) as unknown as typeof fetch;
    await expect(client.chat(MESSAGES, { maxAttempts: 1 })).rejects.toMatchObject({ code: "connection_failed" });
    expect(entered).toBe(1);

    const controllers = Array.from({ length: 8 }, () => new AbortController());
    globalThis.fetch = abortablePendingFetch(() => { entered += 1; });
    const holders = [
      ...controllers.slice(0, 4).map((controller) => client.chat(MESSAGES, {
        workload: "intent", maxAttempts: 1, timeout: 1_000, signal: controller.signal,
      })),
      ...controllers.slice(4).map((controller) => client.chat(MESSAGES, {
        workload: "narration", maxAttempts: 1, timeout: 1_000, signal: controller.signal,
      })),
    ];
    expect(entered).toBe(9);
    await expect(client.chat(MESSAGES, {
      maxAttempts: 1,
      workload: "not-a-workload" as unknown as "default",
    })).rejects.toMatchObject({ code: "request_invalid" });
    await expect(client.chat(MESSAGES, { maxAttempts: 1 })).rejects.toMatchObject({ code: "breaker_open" });
    expect(entered).toBe(9);
    await abortAndSettle(controllers, holders);
  });

  test("releases a half-open breaker probe when admission is full", async () => {
    const endpoint = "http://llm-provider-concurrency-half-open.test/v1";
    const client = new LLMClient({ ...CONFIG, baseUrl: endpoint });
    const originalNow = Date.now;
    const originalCooldown = process.env.LLM_BREAKER_COOLDOWN_MS;
    let now = 10_000;
    Date.now = () => now;
    process.env.LLM_BREAKER_COOLDOWN_MS = "100";
    try {
      globalThis.fetch = (async () => { throw new TypeError("trip intent breaker"); }) as unknown as typeof fetch;
      await expect(client.chat(MESSAGES, { workload: "intent", maxAttempts: 1 })).rejects.toMatchObject({
        code: "connection_failed",
      });

      let entered = 0;
      globalThis.fetch = abortablePendingFetch(() => { entered += 1; });
      const controllers = Array.from({ length: 9 }, () => new AbortController());
      const holders = [
        ...controllers.slice(0, 4).map((controller) => client.chat(MESSAGES, {
          workload: "default", maxAttempts: 1, timeout: 1_000, signal: controller.signal,
        })),
        ...controllers.slice(4, 8).map((controller) => client.chat(MESSAGES, {
          workload: "narration", maxAttempts: 1, timeout: 1_000, signal: controller.signal,
        })),
      ];
      expect(entered).toBe(8);
      now += 100;
      await expect(client.chat(MESSAGES, { workload: "intent", maxAttempts: 1 })).rejects.toMatchObject({
        code: "admission_limited",
      });
      expect(entered).toBe(8);

      controllers[0]!.abort();
      await expect(holders[0]).rejects.toMatchObject({ code: "timeout" });
      const releasedProbe = client.chat(MESSAGES, {
        workload: "intent",
        maxAttempts: 1,
        timeout: 1_000,
        signal: controllers[8]!.signal,
      });
      expect(entered).toBe(9);
      await abortAndSettle(
        [...controllers.slice(1, 8), controllers[8]!],
        [...holders.slice(1), releasedProbe],
      );
    } finally {
      Date.now = originalNow;
      if (originalCooldown === undefined) delete process.env.LLM_BREAKER_COOLDOWN_MS;
      else process.env.LLM_BREAKER_COOLDOWN_MS = originalCooldown;
    }
  });
});
