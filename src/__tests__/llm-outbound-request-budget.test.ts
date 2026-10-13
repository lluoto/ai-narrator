import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LLMClient, type Message } from "../llm/client";

const CONTENT_LIMIT_BYTES = 512 * 1024;
const REQUEST_LIMIT_BYTES = 1024 * 1024;
const CONFIG = {
  apiKey: "sk-test",
  baseUrl: "http://llm-outbound-budget.test/v1",
  model: "test-model",
  maxTokens: 16,
  temperature: 0,
};
const MESSAGES = [{ role: "user" as const, content: "hello" }];
const originalFetch = globalThis.fetch;

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

describe("LLM outbound request budget", () => {
  beforeEach(() => { LLMClient.resetDefeat(); });
  afterEach(() => {
    LLMClient.resetDefeat();
    globalThis.fetch = originalFetch;
  });

  test("counts UTF-8 content before normalization and rejects one byte over the client-owned limit", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return completion("at boundary");
    }) as unknown as typeof fetch;

    const atLimit = "😀".repeat(CONTENT_LIMIT_BYTES / 4);
    await expect(new LLMClient(CONFIG).chat([{ role: "system", content: atLimit }], {
      maxAttempts: 1,
    })).resolves.toBe("at boundary");
    await expect(new LLMClient(CONFIG).chat([{ role: "system", content: `${atLimit}x` }], {
      maxAttempts: 1,
    })).rejects.toMatchObject({
      code: "request_too_large",
      message: "LLM request exceeds client budget",
    });
    expect(requests).toBe(1);
  });

  test("rejects too many messages, a serialized request over the cap, and invalid runtime message shapes before fetch", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return completion();
    }) as unknown as typeof fetch;

    const tooMany = Array.from({ length: 257 }, () => ({ role: "user" as const, content: "x" }));
    await expect(new LLMClient(CONFIG).chat(tooMany, { maxAttempts: 1 })).rejects.toMatchObject({
      code: "request_too_large",
    });
    await expect(new LLMClient({ ...CONFIG, model: "m".repeat(REQUEST_LIMIT_BYTES) }).chat(MESSAGES, {
      maxAttempts: 1,
    })).rejects.toMatchObject({ code: "request_too_large" });
    await expect(new LLMClient(CONFIG).chat([
      { role: "tool", content: "not an allowed role" },
    ] as unknown as Message[], { maxAttempts: 1 })).rejects.toMatchObject({ code: "request_invalid" });
    await expect(new LLMClient(CONFIG).chat([
      { role: "user", content: 42 },
    ] as unknown as Message[], { maxAttempts: 1 })).rejects.toMatchObject({ code: "request_invalid" });
    await expect(new LLMClient(CONFIG).chat({ length: 1 } as unknown as Message[], {
      maxAttempts: 1,
    })).rejects.toMatchObject({ code: "request_invalid" });
    expect(requests).toBe(0);
  });

  test("rejects an over-cap runtime model before JSON serialization for chat and stream", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return completion();
    }) as unknown as typeof fetch;
    const originalStringify = JSON.stringify;
    const hugeModelClient = new LLMClient({ ...CONFIG, model: "m".repeat(REQUEST_LIMIT_BYTES + 1) });
    const errors: unknown[] = [];

    JSON.stringify = (() => {
      throw new Error("model budget must reject before serialization");
    }) as typeof JSON.stringify;
    try {
      try {
        await hugeModelClient.chat(MESSAGES, { maxAttempts: 1 });
      } catch (error) {
        errors.push(error);
      }
      try {
        await collect(hugeModelClient.chatStream(MESSAGES));
      } catch (error) {
        errors.push(error);
      }
    } finally {
      JSON.stringify = originalStringify;
    }

    expect(errors).toHaveLength(2);
    expect(errors).toEqual([
      expect.objectContaining({ code: "request_too_large" }),
      expect.objectContaining({ code: "request_too_large" }),
    ]);
    expect(requests).toBe(0);
  });

  test("rejects invalid token and temperature configuration before the breaker or transport", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return completion();
    }) as unknown as typeof fetch;

    for (const maxTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 32_769]) {
      await expect(new LLMClient(CONFIG).chat(MESSAGES, {
        maxAttempts: 1,
        maxTokens,
      })).rejects.toMatchObject({ code: "request_invalid" });
    }
    await expect(new LLMClient({ ...CONFIG, maxTokens: Number.NaN }).chat(MESSAGES, {
      maxAttempts: 1,
    })).rejects.toMatchObject({ code: "request_invalid" });
    await expect(new LLMClient(CONFIG).chat(MESSAGES, {
      maxAttempts: 1,
      temperature: Number.POSITIVE_INFINITY,
    })).rejects.toMatchObject({ code: "request_invalid" });
    expect(requests).toBe(0);
  });

  test("valid chat retries a single prebuilt wire body rather than serializing request input per attempt", async () => {
    const bodies: string[] = [];
    let reads = 0;
    const message = {
      role: "user" as const,
      get content(): string {
        reads++;
        return "only read while building";
      },
    };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return bodies.length === 1 ? new Response("retry", { status: 500 }) : completion("retried");
    }) as unknown as typeof fetch;

    await expect(new LLMClient(CONFIG).chat([message], { maxAttempts: 2, jsonMode: true })).resolves.toBe("retried");
    expect(reads).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "only read while building" }],
    });
  });

  test("stream validation is lazy but rejects locally before fetch, including while its endpoint breaker is open", async () => {
    const endpoint = "http://llm-outbound-breaker.test/v1";
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;

    await expect(new LLMClient({ ...CONFIG, baseUrl: endpoint }).chat(MESSAGES, {
      maxAttempts: 1,
    })).rejects.toMatchObject({ code: "connection_failed" });
    const stream = new LLMClient({ ...CONFIG, baseUrl: endpoint }).chatStream([
      { role: "user", content: "x".repeat(CONTENT_LIMIT_BYTES + 1) },
    ]);
    expect(requests).toBe(1);
    await expect(collect(stream)).rejects.toMatchObject({ code: "request_too_large" });
    expect(requests).toBe(1);
    await expect(new LLMClient({ ...CONFIG, baseUrl: endpoint }).chat(MESSAGES, {
      maxAttempts: 1,
    })).rejects.toMatchObject({ code: "breaker_open" });
  });

  test("small stream keeps its wire shape and fetches once", async () => {
    let wire: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      wire = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await expect(collect(new LLMClient(CONFIG).chatStream(MESSAGES, { jsonMode: true }))).resolves.toEqual(["streamed"]);
    expect(wire).toMatchObject({
      model: CONFIG.model,
      messages: MESSAGES,
      temperature: CONFIG.temperature,
      max_tokens: CONFIG.maxTokens,
      stream: true,
      stream_options: { include_usage: false },
      response_format: { type: "json_object" },
    });
  });
});
