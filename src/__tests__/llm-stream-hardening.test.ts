import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LLMClient } from "../llm/client";

// These mirror the server-owned stream limits. They are deliberately not
// configurable through ChatOptions or provider-controlled response headers.
const STREAM_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const PENDING_SSE_LIMIT_BYTES = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;
const CONFIG = {
  apiKey: "sk-stream-test",
  baseUrl: "http://llm-stream-hardening.test/v1",
  model: "stream-test-model",
  maxTokens: 16,
  temperature: 0,
};
const MESSAGES = [{ role: "user" as const, content: "hello" }];
const originalFetch = globalThis.fetch;

function client(): LLMClient {
  return new LLMClient(CONFIG);
}

async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function responseWithChunks(chunks: Uint8Array[], onCancel?: () => void): { response: Response; body: ReadableStream<Uint8Array> } {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status: 200 }), body };
}

function neverSettlingBody(onPull: () => void, onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      onPull();
      return new Promise<void>(() => {});
    },
    cancel() {
      onCancel();
      return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
}

function resultWithin<T>(task: Promise<T>, milliseconds = 75): Promise<{ state: "resolved"; value: T } | { state: "rejected"; error: unknown } | { state: "hung" }> {
  return Promise.race([
    task.then(
      (value) => ({ state: "resolved" as const, value }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    ),
    new Promise<{ state: "hung" }>((resolve) => setTimeout(() => resolve({ state: "hung" }), milliseconds)),
  ]);
}

function streamThatExceedsTotalLimit(onCancel: () => void, onPull: (count: number) => void): ReadableStream<Uint8Array> {
  // Each chunk is one ordinary comment line. The source never needs a giant
  // fixture, and the sentinel after the overflowing byte must not be pulled.
  const commentChunk = new Uint8Array(CHUNK_BYTES).fill(0x61);
  commentChunk[0] = 0x3a; // : comment
  commentChunk[commentChunk.length - 1] = 0x0a;
  const fullChunks = STREAM_BODY_LIMIT_BYTES / CHUNK_BYTES;
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      onPull(pulls);
      if (pulls <= fullChunks) {
        controller.enqueue(commentChunk);
      } else if (pulls === fullChunks + 1) {
        controller.enqueue(new Uint8Array([0x0a]));
      } else {
        throw new Error("stream reader pulled past the over-limit byte");
      }
    },
    cancel() {
      onCancel();
    },
  }, { highWaterMark: 0 });
}

function streamWithOversizedPendingLine(onCancel: () => void, onPull: (count: number) => void): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(16 * 1024).fill(0x61);
  const fullChunks = PENDING_SSE_LIMIT_BYTES / chunk.byteLength;
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      onPull(pulls);
      if (pulls <= fullChunks + 1) {
        controller.enqueue(chunk);
      } else {
        throw new Error("stream reader pulled past the oversized pending line");
      }
    },
    cancel() {
      onCancel();
    },
  }, { highWaterMark: 0 });
}

describe("LLM streaming transport hardening", () => {
  beforeEach(() => {
    LLMClient.resetDefeat();
  });

  afterEach(() => {
    LLMClient.resetDefeat();
    globalThis.fetch = originalFetch;
  });

  test("parses chunked multibyte SSE data and accepts standard ignored lines", async () => {
    const encoder = new TextEncoder();
    const wire = encoder.encode(
      ': keepalive\r\nunknown: permitted\r\n\r\ndata:{"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    const multibyteOffset = wire.findIndex((byte) => byte === 0xe4);
    const { response, body } = responseWithChunks([
      wire.slice(0, multibyteOffset + 1),
      wire.slice(multibyteOffset + 1, multibyteOffset + 2),
      wire.slice(multibyteOffset + 2),
    ]);
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    await expect(collect(client().chatStream(MESSAGES))).resolves.toEqual(["你好"]);
    expect(body.locked).toBe(false);
  });

  test("rejects an over-limit declared stream body before pulling and cancels it", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array([0x0a]));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    globalThis.fetch = (async () => new Response(body, {
      status: 200,
      headers: { "Content-Length": String(STREAM_BODY_LIMIT_BYTES + 1) },
    })) as unknown as typeof fetch;

    await expect(collect(client().chatStream(MESSAGES))).rejects.toMatchObject({
      code: "invalid_response",
      message: "LLM returned invalid response",
    });
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  test("stops at the first observed byte over the stream cap without pulling a tail", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = streamThatExceedsTotalLimit(() => { cancelled = true; }, (count) => { pulls = count; });
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    await expect(collect(client().chatStream(MESSAGES))).rejects.toMatchObject({ code: "invalid_response" });
    expect(pulls).toBe((STREAM_BODY_LIMIT_BYTES / CHUNK_BYTES) + 1);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("enforces observed stream bytes when Content-Length underreports the body", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = streamThatExceedsTotalLimit(() => { cancelled = true; }, (count) => { pulls = count; });
    globalThis.fetch = (async () => new Response(body, {
      status: 200,
      headers: { "Content-Length": "1" },
    })) as unknown as typeof fetch;

    await expect(collect(client().chatStream(MESSAGES))).rejects.toMatchObject({ code: "invalid_response" });
    expect(pulls).toBe((STREAM_BODY_LIMIT_BYTES / CHUNK_BYTES) + 1);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("bounds an SSE line that never receives a newline", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = streamWithOversizedPendingLine(() => { cancelled = true; }, (count) => { pulls = count; });
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    await expect(collect(client().chatStream(MESSAGES))).rejects.toMatchObject({ code: "invalid_response" });
    expect(pulls).toBe((PENDING_SSE_LIMIT_BYTES / (16 * 1024)) + 1);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("fails closed for malformed UTF-8 and incomplete UTF-8 at EOF", async () => {
    const malformed = responseWithChunks([new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a])]);
    const incomplete = responseWithChunks([new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe2])]);
    const responses = [malformed.response, incomplete.response];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    for (let index = 0; index < 2; index++) {
      await expect(collect(client().chatStream(MESSAGES))).rejects.toMatchObject({
        code: "invalid_response",
        message: "LLM returned invalid response",
      });
    }
    expect(malformed.body.locked).toBe(false);
    expect(incomplete.body.locked).toBe(false);
  });

  test("fails closed for malformed data JSON and invalid delta content without tripping the breaker", async () => {
    const malformed = responseWithChunks([new TextEncoder().encode("data: {\n\n")]);
    const invalidShape = responseWithChunks([new TextEncoder().encode('data: {"choices":[{"delta":{"content":42}}]}\n\n')]);
    const recovered = responseWithChunks([new TextEncoder().encode("data: [DONE]\n\n")]);
    const responses = [malformed.response, invalidShape.response, recovered.response];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    for (let index = 0; index < 2; index++) {
      await expect(collect(client().chatStream(MESSAGES))).rejects.toMatchObject({
        code: "invalid_response",
        message: "LLM returned invalid response",
      });
    }
    expect(malformed.body.locked).toBe(false);
    expect(invalidShape.body.locked).toBe(false);
    await expect(collect(client().chatStream(MESSAGES))).resolves.toEqual([]);
  });

  test("does not await cancellation of a non-2xx stream body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    globalThis.fetch = (async () => new Response(body, { status: 503 })) as unknown as typeof fetch;

    const result = await resultWithin(collect(client().chatStream(MESSAGES)));
    expect(result).toMatchObject({ state: "rejected", error: { code: "http_error", status: 503 } });
    expect(cancelled).toBe(true);
  });

  test("times out a non-cooperating fetch without tripping its breaker", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return await new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const result = await resultWithin(collect(client().chatStream(MESSAGES, { timeout: 10 })));
    expect(result).toMatchObject({ state: "rejected", error: { code: "timeout" } });
    expect(requests).toBe(1);

    globalThis.fetch = (async () => new Response("data: [DONE]\n\n", { status: 200 })) as unknown as typeof fetch;
    await expect(collect(client().chatStream(MESSAGES))).resolves.toEqual([]);
  });

  test("maps caller abort during a non-cooperating fetch to a prompt cancelled timeout", async () => {
    const cancellation = new AbortController();
    let enterFetch!: () => void;
    const enteredFetch = new Promise<void>((resolve) => { enterFetch = resolve; });
    globalThis.fetch = (async () => {
      enterFetch();
      return await new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const pending = collect(client().chatStream(MESSAGES, { timeout: 250, signal: cancellation.signal }));
    await enteredFetch;
    cancellation.abort();
    const result = await resultWithin(pending);
    expect(result).toMatchObject({
      state: "rejected",
      error: { code: "timeout", message: "LLM request cancelled" },
    });
  });

  test("races a non-cooperating response body against timeout and cancels/releases it", async () => {
    let startPull!: () => void;
    const startedPull = new Promise<void>((resolve) => { startPull = resolve; });
    let cancelled = false;
    const body = neverSettlingBody(startPull, () => { cancelled = true; });
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    const pending = collect(client().chatStream(MESSAGES, { timeout: 10 }));
    await startedPull;
    const result = await resultWithin(pending);
    expect(result).toMatchObject({ state: "rejected", error: { code: "timeout" } });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("races caller abort during a non-cooperating response body and cancels/releases it", async () => {
    const cancellation = new AbortController();
    let startPull!: () => void;
    const startedPull = new Promise<void>((resolve) => { startPull = resolve; });
    let cancelled = false;
    const body = neverSettlingBody(startPull, () => { cancelled = true; });
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    const pending = collect(client().chatStream(MESSAGES, { timeout: 250, signal: cancellation.signal }));
    await startedPull;
    cancellation.abort();
    const result = await resultWithin(pending);
    expect(result).toMatchObject({
      state: "rejected",
      error: { code: "timeout", message: "LLM request cancelled" },
    });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("cancels and releases the reader when a consumer returns early", async () => {
    let cancelled = false;
    const { response, body } = responseWithChunks([
      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'),
    ], () => { cancelled = true; });
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const stream = client().chatStream(MESSAGES);
    await expect(stream.next()).resolves.toMatchObject({ value: "first", done: false });
    await stream.return(undefined);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("releases a clean EOF without a DONE event", async () => {
    const { response, body } = responseWithChunks([
      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"tail"}}]}\n\n'),
    ]);
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    await expect(collect(client().chatStream(MESSAGES))).resolves.toEqual(["tail"]);
    expect(body.locked).toBe(false);
  });
});
