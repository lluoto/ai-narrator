// 熔断要能自愈。
//
// 起因是读一局的诊断日志：整局只有两行，第二行是「LLM 已熔断（之前连接失败）」。
// 追进去发现熔断标志是 **static 且永不恢复** 的：没有冷却、没有半开，
// `resetDefeat()` 只有两个诊断脚本在调，生产代码一次都没调过。
//
// `server.ts` 是长期进程 —— 一次网络抖动就让整个进程往后所有会话退回模板，
// 而且是跨会话的：一个人连不上，把所有人的 LLM 一起带走。

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LLMClient } from "../llm/client";

const CFG = {
  // 指向一个必然连不上的地址：要的就是「连接失败」而不是超时。
  apiKey: "sk-x", baseUrl: "http://127.0.0.1:1", model: "m",
  maxTokens: 16, temperature: 0,
};

const client = () => new LLMClient(CFG);
const MSG = [{ role: "user" as const, content: "hi" }];
const originalFetch = globalThis.fetch;

function configFor(baseUrl: string, apiKey = "sk-x") {
  return { ...CFG, baseUrl, apiKey };
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

/**
 * 返回「这一次是真去连了，还是被熔断挡下了」。
 *
 * ⚠ 不能用 `toContain("连接失败")` 区分这两件事：熔断的报错原文是
 *   **「LLM 已熔断（之前连接失败）」——它本身就含「连接失败」**。
 *   第一版测试正是这么写的，六条全绿，而把熔断改成永不恢复的变异
 *   **一条都没红** —— 断言等于没写。
 */
async function attempt(): Promise<"短路" | "真去连了" | "没抛"> {
  try { await client().chat(MSG); } catch (e) {
    return /已熔断/.test((e as Error).message) ? "短路" : "真去连了";
  }
  return "没抛";
}

describe("LLM 熔断", () => {
  test("endpoint isolation: A failure does not block B, while clients on normalized A share the breaker", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "30000";
    const endpointA = "http://127.0.0.1:19001/v1/";
    const endpointB = "http://127.0.0.1:19002/v1";
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith(endpointA)) throw new TypeError("A refused connection");
      return completion("B is available");
    }) as typeof fetch;

    await expect(new LLMClient(configFor(endpointA)).chat(MSG)).rejects.toThrow("连接失败");
    await expect(new LLMClient(configFor(endpointB)).chat(MSG)).resolves.toBe("B is available");
    await expect(
      new LLMClient(configFor("HTTP://127.0.0.1:19001/v1", "sk-other-secret")).chat(MSG)
    ).rejects.toThrow("已熔断");

    expect(requests).toEqual([
      "http://127.0.0.1:19001/v1//chat/completions",
      "http://127.0.0.1:19002/v1/chat/completions",
    ]);
  });

  test("chat and chatStream share an endpoint breaker, while another endpoint stream can run", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "30000";
    const endpointA = "http://127.0.0.1:19011/v1";
    const endpointB = "http://127.0.0.1:19012/v1";
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith(endpointA)) throw new TypeError("A refused connection");
      return new Response('data: {"choices":[{"delta":{"content":"B stream"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
      });
    }) as typeof fetch;

    await expect(new LLMClient(configFor(endpointA)).chat(MSG)).rejects.toThrow("连接失败");
    await expect(collect(new LLMClient(configFor(endpointA)).chatStream(MSG))).rejects.toThrow("已熔断");
    await expect(collect(new LLMClient(configFor(endpointB)).chatStream(MSG))).resolves.toEqual(["B stream"]);
    expect(requests).toEqual([
      "http://127.0.0.1:19011/v1/chat/completions",
      "http://127.0.0.1:19012/v1/chat/completions",
    ]);
  });

  test("chatStream forwards caller cancellation to fetch and rejects without tripping its breaker", async () => {
    const endpoint = "http://127.0.0.1:19016/v1";
    const cancellation = new AbortController();
    let entered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => { entered = resolve; });
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      entered();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("caller cancelled stream");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }) as unknown as typeof fetch;

    const pending = collect(new LLMClient(configFor(endpoint)).chatStream(MSG, { signal: cancellation.signal }));
    await fetchEntered;
    cancellation.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    // Fetch may wrap RequestInit.signal, so assert cancellation propagation
    // rather than object identity at the transport boundary.
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(true);

    // Cancellation must not poison the endpoint breaker.
    globalThis.fetch = (async () => new Response('data: [DONE]\n\n', { status: 200 })) as unknown as typeof fetch;
    await expect(collect(new LLMClient(configFor(endpoint)).chatStream(MSG))).resolves.toEqual([]);
  });

  test("half-open permits only one concurrent probe and closes after that probe succeeds", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "0";
    const endpoint = "http://127.0.0.1:19021/v1";
    let requests = 0;
    let resolveProbe: ((response: Response) => void) | undefined;
    globalThis.fetch = (async () => {
      requests++;
      if (requests === 1) throw new TypeError("initial connection failure");
      if (requests === 2) {
        return await new Promise<Response>((resolve) => { resolveProbe = resolve; });
      }
      return completion("parallel probe should not run");
    }) as unknown as typeof fetch;

    const firstClient = new LLMClient(configFor(endpoint));
    const secondClient = new LLMClient(configFor(endpoint));
    await expect(firstClient.chat(MSG)).rejects.toThrow("连接失败");

    const probe = firstClient.chat(MSG);
    await expect(secondClient.chat(MSG)).rejects.toThrow("已熔断");
    expect(requests).toBe(2);

    resolveProbe?.(completion("probe succeeded"));
    await expect(probe).resolves.toBe("probe succeeded");

    globalThis.fetch = (async () => {
      requests++;
      return completion("normal again");
    }) as unknown as typeof fetch;
    await expect(secondClient.chat(MSG)).resolves.toBe("normal again");
    expect(requests).toBe(3);
  });

  test("a failed half-open probe reopens the same endpoint breaker", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "0";
    const endpoint = "http://127.0.0.1:19031/v1";
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new TypeError("connection failure");
    }) as unknown as typeof fetch;

    const firstClient = new LLMClient(configFor(endpoint));
    const secondClient = new LLMClient(configFor(endpoint));
    await expect(firstClient.chat(MSG)).rejects.toThrow("连接失败");
    process.env.LLM_BREAKER_COOLDOWN_MS = "30000";
    await expect(secondClient.chat(MSG)).rejects.toThrow("连接失败");

    await expect(firstClient.chat(MSG)).rejects.toThrow("已熔断");
    expect(requests).toBe(2);
  });

  test("resetDefeat clears breaker state for every endpoint", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "30000";
    const endpointA = "http://127.0.0.1:19041/v1";
    const endpointB = "http://127.0.0.1:19042/v1";
    let fail = true;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (fail) throw new TypeError("connection failure");
      return completion("recovered");
    }) as unknown as typeof fetch;

    await expect(new LLMClient(configFor(endpointA)).chat(MSG)).rejects.toThrow("连接失败");
    await expect(new LLMClient(configFor(endpointB)).chat(MSG)).rejects.toThrow("连接失败");
    LLMClient.resetDefeat();
    fail = false;

    await expect(new LLMClient(configFor(endpointA)).chat(MSG)).resolves.toBe("recovered");
    await expect(new LLMClient(configFor(endpointB)).chat(MSG)).resolves.toBe("recovered");
    expect(requests).toBe(4);
  });

  test("a timed-out half-open probe releases its slot without tripping, so the next call fetches", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "0";
    const endpoint = "http://127.0.0.1:19051/v1";
    let phase: "fail" | "timeout" | "success" = "fail";
    let requests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requests++;
      if (phase === "fail") throw new TypeError("connection failure");
      if (phase === "success") return completion("after timeout");
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("probe timed out");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }) as unknown as typeof fetch;

    const clientForEndpoint = new LLMClient(configFor(endpoint));
    await expect(clientForEndpoint.chat(MSG)).rejects.toThrow("连接失败");
    phase = "timeout";
    await expect(clientForEndpoint.chat(MSG, { timeout: 5 })).rejects.toThrow("超时");

    phase = "success";
    await expect(clientForEndpoint.chat(MSG)).resolves.toBe("after timeout");
    expect(requests).toBe(4); // one failure, two timeout retries, then a real recovery fetch
  });

  test("keeps the timeout active while a 200 response body is still parsing", async () => {
    const endpoint = "http://127.0.0.1:19056/v1";
    let requests = 0;
    globalThis.fetch = (async (_input: unknown) => {
      requests++;
      const body = new ReadableStream<Uint8Array>({
        // This body deliberately ignores fetch's AbortSignal. The client must
        // own an explicit read deadline rather than rely on provider behavior.
        start() {},
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await Promise.race([
      new LLMClient(configFor(endpoint)).chat(MSG, { timeout: 5, maxAttempts: 1 }).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "hung" }>((resolve) => setTimeout(() => resolve({ status: "hung" }), 50)),
    ]);
    expect(result).toMatchObject({ status: "rejected", error: { code: "timeout" } });
    expect(requests).toBe(1);
  });

  test("does not await a non-2xx response body's non-cooperating cancellation", async () => {
    const endpoint = "http://127.0.0.1:19057/v1";
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      const body = new ReadableStream<Uint8Array>({
        cancel() { return new Promise<void>(() => {}); },
      });
      return new Response(body, { status: 500 });
    }) as unknown as typeof fetch;

    const result = await Promise.race([
      new LLMClient(configFor(endpoint)).chat(MSG, { maxAttempts: 1 }).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "hung" }>((resolve) => setTimeout(() => resolve({ status: "hung" }), 50)),
    ]);
    expect(result).toMatchObject({ status: "rejected", error: { code: "http_error", status: 500 } });
    expect(requests).toBe(1);
  });

  test("a non-2xx half-open response releases its slot without changing HTTP error policy", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "0";
    const endpoint = "http://127.0.0.1:19061/v1";
    let phase: "fail" | "http-error" | "success" = "fail";
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (phase === "fail") throw new TypeError("connection failure");
      if (phase === "http-error") return new Response("bad request", { status: 400 });
      return completion("after HTTP error");
    }) as unknown as typeof fetch;

    const clientForEndpoint = new LLMClient(configFor(endpoint));
    await expect(clientForEndpoint.chat(MSG)).rejects.toThrow("连接失败");
    phase = "http-error";
    await expect(clientForEndpoint.chat(MSG)).rejects.toThrow("LLM API returned HTTP 400");

    phase = "success";
    await expect(clientForEndpoint.chat(MSG)).resolves.toBe("after HTTP error");
    expect(requests).toBe(3);
  });

  test("an empty half-open response releases its slot, so the next call can fetch", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "0";
    const endpoint = "http://127.0.0.1:19071/v1";
    let phase: "fail" | "empty" | "success" = "fail";
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (phase === "fail") throw new TypeError("connection failure");
      if (phase === "empty") return completion("");
      return completion("after empty response");
    }) as unknown as typeof fetch;

    const clientForEndpoint = new LLMClient(configFor(endpoint));
    await expect(clientForEndpoint.chat(MSG)).rejects.toThrow("连接失败");
    phase = "empty";
    await expect(clientForEndpoint.chat(MSG)).rejects.toThrow("LLM returned empty response");

    phase = "success";
    await expect(clientForEndpoint.chat(MSG)).resolves.toBe("after empty response");
    expect(requests).toBe(3);
  });

  beforeEach(() => { LLMClient.resetDefeat(); });
  afterEach(() => {
    LLMClient.resetDefeat();
    globalThis.fetch = originalFetch;
    delete process.env.LLM_BREAKER_COOLDOWN_MS;
  });

  test("**正确**：连接失败会跳闸，后续调用立刻短路", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "30000";
    expect(await attempt()).toBe("真去连了");
    expect(await attempt()).toBe("短路");
  });

  test("**错误行为的红线**：冷却到点后必须自愈，不能永久熔断", async () => {
    // 改之前 `_defeated = true` 永不复位，这条会一直是「短路」。
    process.env.LLM_BREAKER_COOLDOWN_MS = "0";
    expect(await attempt()).toBe("真去连了"); // 跳闸
    expect(await attempt()).toBe("真去连了"); // 冷却已过 → 半开放行
  });

  test("**正确**：半开时再失败要重新跳闸，而不是从此一直放行", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "0";
    expect(await attempt()).toBe("真去连了");
    process.env.LLM_BREAKER_COOLDOWN_MS = "30000";
    expect(await attempt()).toBe("真去连了"); // 半开这次用长冷却，失败后重新跳闸
    expect(await attempt()).toBe("短路");
  });

  test("**干扰输入**：冷却时长非法时回落到默认值，不能变成永不熔断", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "不是数字";
    expect(await attempt()).toBe("真去连了");
    expect(await attempt()).toBe("短路");
  });

  test("**错误行为的红线**：流式调用也要看同一个熔断", async () => {
    // 原先 `chatStream` 一开头不查熔断 —— 同一个熔断两条路两种待遇。
    process.env.LLM_BREAKER_COOLDOWN_MS = "30000";
    await attempt();
    let msg = "(没抛)";
    try {
      for await (const _ of client().chatStream(MSG)) { /* 不该走到这 */ }
    } catch (e) { msg = (e as Error).message; }
    expect(/已熔断/.test(msg)).toBe(true);
  });

  test("**正确**：resetDefeat 立即清掉熔断", async () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "30000";
    await attempt();
    expect(await attempt()).toBe("短路");
    LLMClient.resetDefeat();
    expect(await attempt()).toBe("真去连了");
  });
});
