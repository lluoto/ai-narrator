import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LLMClient } from "../llm/client";

// This mirrors the server-owned transport contract, rather than exposing a
// test-only production knob that a request could use to enlarge the limit.
const RESPONSE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const CONFIG = {
  apiKey: "sk-test",
  baseUrl: "http://llm-response-limit.test/v1",
  model: "test-model",
  maxTokens: 16,
  temperature: 0,
};
const MESSAGES = [{ role: "user" as const, content: "hello" }];
const originalFetch = globalThis.fetch;

function client(): LLMClient {
  return new LLMClient(CONFIG);
}

function jsonResponse(content = "ok"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function pendingBody(onPull: () => void, onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      onPull();
      return new Promise<void>(() => {});
    },
    cancel() {
      onCancel();
    },
  }, { highWaterMark: 0 });
}

function limitThenTailStream(onCancel: () => void, onPull: (count: number) => void): ReadableStream<Uint8Array> {
  const fullChunks = RESPONSE_BODY_LIMIT_BYTES / CHUNK_BYTES;
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      onPull(pulls);
      if (pulls <= fullChunks) {
        controller.enqueue(new Uint8Array(CHUNK_BYTES));
      } else if (pulls === fullChunks + 1) {
        // The first byte over the cap must stop all further reads.
        controller.enqueue(new Uint8Array(1));
      } else {
        // This chunk must never be requested by the bounded reader.
        controller.enqueue(new Uint8Array(1));
        controller.close();
      }
    },
    cancel() {
      onCancel();
    },
  }, { highWaterMark: 0 });
}

describe("LLM successful-response body resource limits", () => {
  beforeEach(() => {
    LLMClient.resetDefeat();
  });

  afterEach(() => {
    LLMClient.resetDefeat();
    globalThis.fetch = originalFetch;
  });

  test("parses a small valid JSON completion", async () => {
    globalThis.fetch = (async () => jsonResponse("small response")) as unknown as typeof fetch;

    await expect(client().chat(MESSAGES, { maxAttempts: 1 })).resolves.toBe("small response");
  });

  test("rejects an oversized declared Content-Length before reading and cancels the body", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array([0x7b, 0x7d]));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    globalThis.fetch = (async () => new Response(body, {
      status: 200,
      headers: { "Content-Length": String(RESPONSE_BODY_LIMIT_BYTES + 1) },
    })) as unknown as typeof fetch;

    await expect(client().chat(MESSAGES, { maxAttempts: 1 })).rejects.toMatchObject({
      code: "invalid_response",
      message: "LLM returned invalid response",
    });
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  test("stops at the first observed byte over a missing Content-Length and cancels without reading the tail", async () => {
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async () => new Response(
      limitThenTailStream(() => { cancelled = true; }, (count) => { pulls = count; }),
      { status: 200 },
    )) as unknown as typeof fetch;

    await expect(client().chat(MESSAGES, { maxAttempts: 1 })).rejects.toMatchObject({ code: "invalid_response" });
    expect(pulls).toBe((RESPONSE_BODY_LIMIT_BYTES / CHUNK_BYTES) + 1);
    expect(cancelled).toBe(true);
  });

  test("enforces observed bytes when Content-Length underreports the body", async () => {
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async () => new Response(
      limitThenTailStream(() => { cancelled = true; }, (count) => { pulls = count; }),
      { status: 200, headers: { "Content-Length": "1" } },
    )) as unknown as typeof fetch;

    await expect(client().chat(MESSAGES, { maxAttempts: 1 })).rejects.toMatchObject({ code: "invalid_response" });
    expect(pulls).toBe((RESPONSE_BODY_LIMIT_BYTES / CHUNK_BYTES) + 1);
    expect(cancelled).toBe(true);
  });

  test("rejects invalid UTF-8 and malformed JSON with the opaque invalid-response error", async () => {
    const invalidUtf8 = new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]);
    const replies = [
      new Response(invalidUtf8, { status: 200 }),
      new Response("{", { status: 200 }),
      new Response(null, { status: 200 }),
    ];
    globalThis.fetch = (async () => replies.shift()!) as unknown as typeof fetch;

    for (let index = 0; index < 3; index++) {
      await expect(client().chat(MESSAGES, { maxAttempts: 1 })).rejects.toMatchObject({
        code: "invalid_response",
        message: "LLM returned invalid response",
      });
    }
  });

  test("keeps its absolute timeout through a non-cooperating response stream and cancels it", async () => {
    let pullStarted!: () => void;
    const started = new Promise<void>((resolve) => { pullStarted = resolve; });
    let cancelled = false;
    globalThis.fetch = (async () => new Response(
      pendingBody(pullStarted, () => { cancelled = true; }),
      { status: 200 },
    )) as unknown as typeof fetch;

    const pending = client().chat(MESSAGES, { maxAttempts: 1, timeout: 10 });
    await started;
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(true);
  });

  test("maps caller cancellation during a non-cooperating response stream to timeout and cancels it", async () => {
    const cancellation = new AbortController();
    let pullStarted!: () => void;
    const started = new Promise<void>((resolve) => { pullStarted = resolve; });
    let cancelled = false;
    globalThis.fetch = (async () => new Response(
      pendingBody(pullStarted, () => { cancelled = true; }),
      { status: 200 },
    )) as unknown as typeof fetch;

    const pending = client().chat(MESSAGES, {
      maxAttempts: 1,
      timeout: 250,
      signal: cancellation.signal,
    });
    await started;
    cancellation.abort();
    const result = await Promise.race([
      pending.then(
        () => ({ state: "resolved" as const }),
        (error: unknown) => ({ state: "rejected" as const, error }),
      ),
      new Promise<{ state: "hung" }>((resolve) => setTimeout(() => resolve({ state: "hung" }), 50)),
    ]);

    expect(result).toMatchObject({ state: "rejected", error: { code: "timeout" } });
    expect(cancelled).toBe(true);
  });
});
