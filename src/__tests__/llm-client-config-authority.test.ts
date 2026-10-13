import { describe, expect, it } from "bun:test";
import type { LLMConfig } from "../config";
import { LLMClient } from "../llm/client";

function config(): LLMConfig {
  return {
    apiKey: "sk-llm-client-canonical",
    baseUrl: "https://canonical-llm-client.invalid/v1",
    model: "canonical-client-model",
    maxTokens: 17,
    temperature: 0.25,
  };
}

function completion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function streamCompletion(content: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function mutateCallerConfig(value: LLMConfig): void {
  value.apiKey = "sk-llm-client-mutated";
  value.baseUrl = "https://mutated-llm-client.invalid/v1";
  value.model = "mutated-client-model";
  value.maxTokens = 9;
  value.temperature = 0.9;
}

interface ObservedRequest {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function transportProjection(requests: ObservedRequest[]): Array<Record<string, unknown>> {
  return requests.map(({ url, authorization, body }) => ({
    url,
    authorization,
    model: body.model,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
  }));
}

const canonicalTransport = {
  url: "https://canonical-llm-client.invalid/v1/chat/completions",
  authorization: "Bearer sk-llm-client-canonical",
  model: "canonical-client-model",
  maxTokens: 17,
  temperature: 0.25,
};

describe("LLMClient configuration authority", () => {
  it("does not expose an own config or credential-bearing reflection surface", () => {
    const client = new LLMClient(config());
    const ownKeys = Reflect.ownKeys(client);
    expect(ownKeys).not.toContain("config");
    expect(ownKeys).not.toContain("apiKey");
    expect(Object.keys(client)).not.toContain("config");
    expect((client as unknown as Record<string, unknown>).config).toBeUndefined();
  });

  it("keeps chat and stream requests on construction-time config despite caller alias mutation", async () => {
    const supplied = config();
    const originalFetch = globalThis.fetch;
    const requests: ObservedRequest[] = [];
    LLMClient.resetDefeat();
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return requests.length === 1 ? completion("chat canonical") : streamCompletion("stream canonical");
    }) as typeof fetch;

    try {
      const client = new LLMClient(supplied);
      mutateCallerConfig(supplied);

      await expect(client.chat([{ role: "user", content: "hello" }], { maxAttempts: 1 })).resolves.toBe("chat canonical");
      await expect(collect(client.chatStream([{ role: "user", content: "hello" }]))).resolves.toEqual(["stream canonical"]);
      expect(requests).toHaveLength(2);
      expect(transportProjection(requests)).toEqual([canonicalTransport, canonicalTransport]);
      expect(requests[1]!.body).toMatchObject({ stream: true, stream_options: { include_usage: false } });
    } finally {
      globalThis.fetch = originalFetch;
      LLMClient.resetDefeat();
    }
  });

  it("keeps chat and stream requests canonical when a same-name config shadow exists", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ObservedRequest[] = [];
    LLMClient.resetDefeat();
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return requests.length === 1 ? completion("chat canonical") : streamCompletion("stream canonical");
    }) as typeof fetch;

    try {
      const client = new LLMClient(config());
      Object.defineProperty(client, "config", {
        configurable: true,
        value: {
          apiKey: "sk-shadow",
          baseUrl: "https://shadow.invalid/v1",
          model: "shadow-model",
          maxTokens: 1,
          temperature: 1,
        },
      });

      await expect(client.chat([{ role: "user", content: "hello" }], { maxAttempts: 1 })).resolves.toBe("chat canonical");
      await expect(collect(client.chatStream([{ role: "user", content: "hello" }]))).resolves.toEqual(["stream canonical"]);
      expect(requests).toHaveLength(2);
      expect(transportProjection(requests)).toEqual([canonicalTransport, canonicalTransport]);
    } finally {
      globalThis.fetch = originalFetch;
      LLMClient.resetDefeat();
    }
  });

  it("maps a hostile constructor config getter to request_invalid without exposing its secret", () => {
    const secret = "constructor-config-getter-secret";
    const hostile = {
      get apiKey(): never { throw new Error(secret); },
      baseUrl: "https://hostile.invalid/v1",
      model: "hostile-model",
      maxTokens: 16,
      temperature: 0,
    } as unknown as LLMConfig;
    let observed: unknown;
    try {
      new LLMClient(hostile);
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ code: "request_invalid", message: "LLM request is invalid" });
    expect(String(observed)).not.toContain(secret);
  });
});
