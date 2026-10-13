// OpenAI-compatible LLM client with streaming support
// Works with: OpenAI, DeepSeek, Ollama, and any OpenAI-compatible API

import type { LLMConfig } from "../config";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Caps retry attempts for a latency-bounded workload. Defaults to the legacy two attempts. */
  maxAttempts?: number;
  /** Force JSON output (OpenAI/DeepSeek compatible) */
  jsonMode?: boolean;
  /** 超时时间（毫秒），默认 120000（ECNU/DeepSeek 代理实测生成 100 tokens 需 ~80s） */
  timeout?: number;
  /**
   * Breakers are shared only within a normalized endpoint and workload.  A
   * generation outage must not make structured player intent unavailable.
   */
  workload?: LLMWorkload;
  /** Cooperative caller cancellation; transports must not retry an aborted workload. */
  signal?: AbortSignal;
}

export type LLMWorkload = "default" | "intent" | "narration";
export type LLMFailureCode =
  | "breaker_open"
  | "admission_limited"
  | "timeout"
  | "connection_failed"
  | "http_error"
  | "invalid_response"
  | "request_invalid"
  | "request_too_large";

/** Typed operational failures let callers fail closed without publishing provider text. */
export class LLMClientError extends Error {
  constructor(readonly code: LLMFailureCode, message: string, readonly status?: number) {
    super(message);
    this.name = "LLMClientError";
  }
}

interface BreakerState {
  defeatedUntil: number;
  probing: boolean;
}

interface ProviderAdmissionState {
  total: number;
  byWorkload: Record<LLMWorkload, number>;
}

interface ProviderAdmissionLease {
  release(): void;
}

/**
 * 会话与各 Agent 实际依赖的 LLM 调用面。
 *
 * 没有 API key 时装配的是 MockLLMClient，它与 LLMClient 没有共同基类，
 * 但 chat 的签名完全一致。消费方按本接口声明参数，就不必再假装拿到的一定是 LLMClient。
 */
export interface LLMLike {
  chat(messages: Message[], options?: ChatOptions): Promise<string>;
}

/**
 * 从 chat-completion 响应里取正文。
 *
 * 响应来自外部 API，`resp.json()` 的类型是 unknown；此前各调用点要么各写一遍
 * `json.choices?.[0]?.message?.content` 这条链，要么用 `const json: any` 绕开检查。
 * 形状不符一律回退空串，由调用方自行决定抛错还是降级。
 */
export function extractMessageContent(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const { choices } = payload as { choices?: unknown };
  if (!Array.isArray(choices)) return "";
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return "";
  const { message } = first as { message?: unknown };
  if (typeof message !== "object" || message === null) return "";
  const { content } = message as { content?: unknown };
  return typeof content === "string" ? content : "";
}

// A provider response is untrusted transport input. This cap is deliberately
// owned by the client, not by max_tokens or a provider-supplied header.
const MAX_SUCCESS_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
// Streaming input is untrusted too. These limits remain client-owned so no
// caller option or provider header can make a long-lived stream unbounded.
const MAX_STREAM_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_SSE_BYTES = 256 * 1024;
// These caps are deliberately client-owned. Request options, provider hints,
// and deployment configuration cannot enlarge the prompt or output budget.
const MAX_REQUEST_MESSAGES = 256;
const MAX_REQUEST_CONTENT_BYTES = 512 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_TOKENS = 32_768;
// Provider admission is process-local defence-in-depth, not a distributed
// rate/cost quota. Keep it client-owned so runtime configuration and requests
// cannot widen it.
const MAX_ACTIVE_PROVIDER_CALLS_PER_ENDPOINT = 8;
const MAX_ACTIVE_PROVIDER_CALLS_PER_WORKLOAD = 4;
const INVALID_RESPONSE_MESSAGE = "LLM returned invalid response";
const INVALID_REQUEST_MESSAGE = "LLM request is invalid";
const REQUEST_TOO_LARGE_MESSAGE = "LLM request exceeds client budget";
const ADMISSION_LIMITED_MESSAGE = "LLM provider concurrency limit reached";

function invalidResponse(): LLMClientError {
  return new LLMClientError("invalid_response", INVALID_RESPONSE_MESSAGE);
}

function invalidRequest(): LLMClientError {
  return new LLMClientError("request_invalid", INVALID_REQUEST_MESSAGE);
}

/**
 * A client owns the endpoint and credential it was constructed with.  Copy
 * each field before a transport can retain caller-owned configuration, and
 * never publish that credential-bearing record on the instance surface.
 */
function canonicalClientConfig(config: LLMConfig): Readonly<LLMConfig> {
  try {
    if (typeof config !== "object" || config === null || Array.isArray(config)) throw invalidRequest();
    const canonical: LLMConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    };
    // These fields reach URL construction and Authorization outside the body
    // serializer, so reject malformed runtime values before they can invoke a
    // hostile coercion hook or expose its details.
    if (typeof canonical.apiKey !== "string" || typeof canonical.baseUrl !== "string") {
      throw invalidRequest();
    }
    return Object.freeze(canonical);
  } catch (error) {
    if (error instanceof LLMClientError) throw error;
    throw invalidRequest();
  }
}

function requestTooLarge(): LLMClientError {
  return new LLMClientError("request_too_large", REQUEST_TOO_LARGE_MESSAGE);
}

function admissionLimited(): LLMClientError {
  return new LLMClientError("admission_limited", ADMISSION_LIMITED_MESSAGE);
}

/**
 * Measures only as far as a client-owned cap permits. This avoids building a
 * second unbounded UTF-8 buffer before rejecting oversized prompt history.
 * Unpaired surrogates match TextEncoder's U+FFFD behavior (three bytes).
 */
function utf8ByteLengthAtMost(value: string, maximum: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return maximum + 1;
  }
  return bytes;
}

function cancelResponseBody(body: ReadableStream<Uint8Array>): void {
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Resource cleanup must not replace the safe protocol error.
  }
}

interface SuccessResponseReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
}

function cancelAndReleaseReader(reader: SuccessResponseReader): void {
  try {
    // Cancellation is only cleanup. A provider-controlled stream may never
    // settle it, so it must not delay the operational failure or lock release.
    void Promise.resolve(reader.cancel(undefined)).catch(() => undefined);
  } catch {
    // The lock may still be releasable after a synchronous cancellation error.
  }
  try { reader.releaseLock(); } catch { /* reader is already released or still pending */ }
}

function declaredBodyExceedsLimit(headers: Headers, limit: number): boolean {
  const contentLength = headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength)) return false;
  try {
    return BigInt(contentLength) > BigInt(limit);
  } catch {
    return false;
  }
}

/** Reads a non-streaming 2xx body without letting a provider choose its memory bound. */
async function parseBoundedSuccessResponse(response: Response, deadline: Promise<never>): Promise<unknown> {
  const body = response.body;
  if (!body) throw invalidResponse();
  if (declaredBodyExceedsLimit(response.headers, MAX_SUCCESS_RESPONSE_BODY_BYTES)) {
    cancelResponseBody(body);
    throw invalidResponse();
  }

  let reader: SuccessResponseReader;
  try {
    reader = body.getReader();
  } catch {
    cancelResponseBody(body);
    throw invalidResponse();
  }

  const chunks: Uint8Array[] = [];
  let observedBytes = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        finished = true;
        break;
      }
      if (!value) continue;

      // Never retain an over-limit chunk or ask the stream for another one.
      if (value.byteLength > MAX_SUCCESS_RESPONSE_BODY_BYTES - observedBytes) {
        throw invalidResponse();
      }
      observedBytes += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof LLMClientError || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    throw invalidResponse();
  } finally {
    if (finished) {
      try { reader.releaseLock(); } catch { /* already released by the transport */ }
    } else {
      cancelAndReleaseReader(reader);
    }
  }

  try {
    const bytes = new Uint8Array(observedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
}

export class LLMClient {
  /** Runtime-private, frozen provider capability. It is intentionally not reflectable. */
  readonly #configRaw: Readonly<LLMConfig>;
  /**
   * 全局熔断。**带冷却**，跳闸后到点自动进半开。
   *
   * ⚠ 原先是 `private static _defeated = false`，一旦置真就**永不恢复**：
   *   没有冷却、没有半开，`resetDefeat()` 又只有两个诊断脚本在调
   *   （注释写着「切换 API key 时调用」，可生产代码里一次都没调过）。
   *
   *   而 `server.ts` 是长期进程、这个标志又是 static ——
   *   **一次网络抖动就让整个进程往后所有会话、所有玩家永久退回模板**，
   *   直到有人手动重启。而且是跨会话的：一个会话连不上，
   *   把其他所有人的 LLM 一起带走。
   *
   *   改成存「熔断到什么时候」：过了冷却就放一个调用过去探路，
   *   成功即自愈，再失败就再跳闸一个冷却。
   */
  /** Per normalized endpoint/workload state; API keys never form part of this key. */
  private static _breakers = new Map<string, BreakerState>();

  /**
   * Logical calls share an endpoint-wide process-local concurrency ceiling.
   * It intentionally omits API keys, just as the breaker does: distinct
   * sessions must not make a single provider endpoint unbounded together.
   */
  private static _providerAdmissions = new Map<string, ProviderAdmissionState>();

  /** 冷却时长。留成环境变量，便于诊断脚本调短了验证自愈。 */
  private static cooldownMs(): number {
    const raw = Number(process.env.LLM_BREAKER_COOLDOWN_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
  }

  private static tripBreaker(breakerKey: string): void {
    LLMClient._breakers.set(breakerKey, {
      defeatedUntil: Date.now() + LLMClient.cooldownMs(),
      probing: false,
    });
  }

  /** 熔断是否仍然张开。到点自动转半开（返回 false，放行一次探路调用）。 */
  private static endpointKey(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.protocol}//${url.host}${path}`;
    } catch {
      const withoutQuery = baseUrl.trim().split(/[?#]/, 1)[0] ?? "";
      return withoutQuery
        .replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, "$1")
        .replace(/\/+$/, "");
    }
  }

  private static breakerKey(baseUrl: string, workload: LLMWorkload): string {
    return `${LLMClient.endpointKey(baseUrl)}\u0000${workload}`;
  }

  private static resolveWorkload(options: ChatOptions): LLMWorkload {
    try {
      const workload: unknown = options.workload;
      if (workload === undefined) return "default";
      if (workload === "default" || workload === "intent" || workload === "narration") return workload;
    } catch {
      // A hostile getter is invalid local input and must not reach shared state.
    }
    throw invalidRequest();
  }

  /**
   * Admission never queues: retaining arbitrary waiters would replace a
   * provider overload with unbounded process memory. The returned lease is
   * idempotent so every transport settlement path can safely use `finally`.
   */
  private static acquireProviderAdmission(baseUrl: string, workload: LLMWorkload): ProviderAdmissionLease {
    const endpointKey = LLMClient.endpointKey(baseUrl);
    let state = LLMClient._providerAdmissions.get(endpointKey);
    if (
      state
      && (state.total >= MAX_ACTIVE_PROVIDER_CALLS_PER_ENDPOINT
        || state.byWorkload[workload] >= MAX_ACTIVE_PROVIDER_CALLS_PER_WORKLOAD)
    ) {
      throw admissionLimited();
    }
    if (!state) {
      state = {
        total: 0,
        byWorkload: { default: 0, intent: 0, narration: 0 },
      };
      LLMClient._providerAdmissions.set(endpointKey, state);
    }
    state.total++;
    state.byWorkload[workload]++;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state!.total--;
        state!.byWorkload[workload]--;
        if (state!.total === 0 && LLMClient._providerAdmissions.get(endpointKey) === state) {
          LLMClient._providerAdmissions.delete(endpointKey);
        }
      },
    };
  }

  /** Remove expired entries for other workloads without disturbing this probe. */
  private static cleanupExpiredBreakers(currentBreakerKey: string, now: number): void {
    for (const [breakerKey, state] of LLMClient._breakers) {
      if (breakerKey !== currentBreakerKey && !state.probing && state.defeatedUntil <= now) {
        LLMClient._breakers.delete(breakerKey);
      }
    }
  }

  /** Returns true only for the single half-open probe that acquired the slot. */
  private static acquireBreaker(breakerKey: string): boolean {
    const now = Date.now();
    LLMClient.cleanupExpiredBreakers(breakerKey, now);
    const state = LLMClient._breakers.get(breakerKey);
    if (!state) return false;
    if (state.defeatedUntil > now || state.probing) {
      throw new LLMClientError("breaker_open", "LLM 已熔断（之前连接失败）");
    }

    state.probing = true;
    return true;
  }

  private static closeBreaker(breakerKey: string): void {
    LLMClient._breakers.delete(breakerKey);
  }

  /** A timeout or non-connection error must not leave half-open stuck forever. */
  private static releaseProbe(breakerKey: string, wasProbe: boolean): void {
    if (!wasProbe) return;
    const state = LLMClient._breakers.get(breakerKey);
    if (!state?.probing) return;

    state.probing = false;
    if (state.defeatedUntil <= Date.now()) LLMClient._breakers.delete(breakerKey);
  }

  constructor(config: LLMConfig) {
    this.#configRaw = canonicalClientConfig(config);
  }

  /** 重置熔断（切换 API key 时调用） */
  static resetDefeat() { LLMClient._breakers.clear(); }

  /**
   * 兼容 ECNU/qwen 代理：多条 system 消息会触发 500。
   * 将连续的所有 system 消息合并为一条（按出现顺序拼接），保留 user/assistant 顺序。
   */
  private normalizeMessages(messages: Message[]): Message[] {
    const sys: string[] = [];
    const out: Message[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        sys.push(m.content);
      } else {
        if (sys.length > 0) {
          out.push({ role: "system", content: sys.join("\n\n") });
          sys.length = 0;
        }
        out.push(m);
      }
    }
    if (sys.length > 0) out.push({ role: "system", content: sys.join("\n\n") });
    return out;
  }

  /**
   * Validates and serializes outbound provider input exactly once. This runs
   * before breaker acquisition so malformed local input cannot be masked by,
   * or mutate, shared endpoint health state.
   */
  private buildRequestBody(messages: Message[], options: ChatOptions, stream: boolean): string {
    try {
      if (typeof options !== "object" || options === null || Array.isArray(options)) {
        throw invalidRequest();
      }
      if (!Array.isArray(messages)) throw invalidRequest();
      if (messages.length > MAX_REQUEST_MESSAGES) throw requestTooLarge();

      const validatedMessages: Message[] = [];
      let contentBytes = 0;
      for (let index = 0; index < messages.length; index++) {
        const candidate: unknown = messages[index];
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
          throw invalidRequest();
        }
        const { role, content } = candidate as { role?: unknown; content?: unknown };
        if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string") {
          throw invalidRequest();
        }
        const remaining = MAX_REQUEST_CONTENT_BYTES - contentBytes;
        const bytes = utf8ByteLengthAtMost(content, remaining);
        if (remaining < 0 || bytes > remaining) throw requestTooLarge();
        contentBytes += bytes;
        // Do not retain caller-owned objects: getters or mutable history must
        // not be revisited by retries or JSON serialization.
        validatedMessages.push({ role, content });
      }

      const maxTokens = options.maxTokens ?? this.#configRaw.maxTokens;
      if (
        typeof maxTokens !== "number"
        || !Number.isInteger(maxTokens)
        || maxTokens <= 0
        || maxTokens > MAX_REQUEST_TOKENS
      ) {
        throw invalidRequest();
      }
      const temperature = options.temperature ?? this.#configRaw.temperature;
      if (typeof temperature !== "number" || !Number.isFinite(temperature)) throw invalidRequest();
      const model = this.#configRaw.model;
      if (typeof model !== "string") throw invalidRequest();
      // `model` originates in runtime configuration. Reject it before
      // JSON.stringify so a malformed deployment cannot force an unbounded
      // extra serialization allocation before the final exact body check.
      if (utf8ByteLengthAtMost(model, MAX_REQUEST_BODY_BYTES) > MAX_REQUEST_BODY_BYTES) {
        throw requestTooLarge();
      }
      const body: Record<string, unknown> = {
        model,
        messages: this.normalizeMessages(validatedMessages),
        temperature,
        max_tokens: maxTokens,
      };
      if (stream) {
        body.stream = true;
        body.stream_options = { include_usage: false };
      }
      if (options.jsonMode) body.response_format = { type: "json_object" };

      const serialized = JSON.stringify(body);
      if (typeof serialized !== "string") throw invalidRequest();
      if (utf8ByteLengthAtMost(serialized, MAX_REQUEST_BODY_BYTES) > MAX_REQUEST_BODY_BYTES) {
        throw requestTooLarge();
      }
      return serialized;
    } catch (error) {
      if (error instanceof LLMClientError) throw error;
      // Input/config getters and JSON serialization must not expose their
      // implementation details or prompt contents through the API boundary.
      throw invalidRequest();
    }
  }

  /** Non-streaming chat — returns full response */
  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const requestBody = this.buildRequestBody(messages, options, false);
    const workload = LLMClient.resolveWorkload(options);
    const breakerKey = LLMClient.breakerKey(this.#configRaw.baseUrl, workload);
    const isProbe = LLMClient.acquireBreaker(breakerKey);
    try {
      const admission = LLMClient.acquireProviderAdmission(this.#configRaw.baseUrl, workload);
      try {

        const timeout = options.timeout ?? 300000;
        // ECNU/qwen 代理响应波动大（3s~90s+）：超时/瞬时错误自动重试 1 次。
        // Latency-bounded callers may explicitly keep the whole operation to one attempt.
        const requestedAttempts = options.maxAttempts ?? 2;
        const maxAttempts = Number.isFinite(requestedAttempts)
          ? Math.max(1, Math.min(2, Math.trunc(requestedAttempts)))
          : 2;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const controller = new AbortController();
          if (options.signal?.aborted) throw new LLMClientError("timeout", "LLM request cancelled");
          let timedOut = false;
          // Keep the deadline through response-body parsing: an HTTP 200 body may
          // otherwise hold a session action FIFO forever.
          let rejectDeadline!: (reason: LLMClientError) => void;
          const deadline = new Promise<never>((_resolve, reject) => {
            rejectDeadline = reject;
          });
          const abortFromCaller = () => {
            controller.abort();
            rejectDeadline(new LLMClientError("timeout", "LLM request cancelled"));
          };
          options.signal?.addEventListener("abort", abortFromCaller, { once: true });
          const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
            rejectDeadline(new LLMClientError("timeout", "LLM 请求超时"));
          }, timeout);
          try {
          let resp: Response;
          try {
            resp = await Promise.race([
              fetch(`${this.#configRaw.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${this.#configRaw.apiKey}`,
                },
                body: requestBody,
                signal: controller.signal,
              }),
              deadline,
            ]);
          } catch (err: unknown) {
            const isTimeout = timedOut
              || (err instanceof LLMClientError && err.code === "timeout")
              || (err instanceof Error && err.name === "AbortError");
            if (!isTimeout) LLMClient.tripBreaker(breakerKey);
            if (isTimeout && options.signal?.aborted) throw new LLMClientError("timeout", "LLM request cancelled");
            if (isTimeout && attempt + 1 < maxAttempts) continue; // 超时重试 1 次
            throw new LLMClientError(
              isTimeout ? "timeout" : "connection_failed",
              isTimeout ? "LLM 请求超时" : "LLM 连接失败",
            );
          }
          if (!resp.ok) {
            // Provider error bodies are opaque. Cancellation is only resource
            // hygiene, never part of the action deadline or HTTP error path.
            if (resp.body) void resp.body.cancel().catch(() => undefined);
            // 5xx 服务端瞬时错误：重试 1 次
            if (resp.status >= 500 && attempt + 1 < maxAttempts) continue;
            throw new LLMClientError("http_error", `LLM API returned HTTP ${resp.status}`, resp.status);
          }

          let payload: unknown;
          try {
            payload = await parseBoundedSuccessResponse(resp, deadline);
          } catch (err: unknown) {
            const isTimeout = timedOut
              || (err instanceof LLMClientError && err.code === "timeout")
              || (err instanceof Error && err.name === "AbortError");
            if (isTimeout && resp.body) void resp.body.cancel().catch(() => undefined);
            if (isTimeout && options.signal?.aborted) throw new LLMClientError("timeout", "LLM request cancelled");
            if (isTimeout && attempt + 1 < maxAttempts) continue;
            if (isTimeout) throw new LLMClientError("timeout", "LLM 请求超时");
            // A 200 with malformed transport JSON is a provider protocol error,
            // not an unavailable model. Do not retain or publish its raw body.
            throw invalidResponse();
          }
          const content = extractMessageContent(payload);
          if (!content) throw new LLMClientError("invalid_response", "LLM returned empty response");
          LLMClient.closeBreaker(breakerKey);
          return content;
          } finally {
            clearTimeout(timeoutId);
            options.signal?.removeEventListener("abort", abortFromCaller);
          }
        }
        throw new LLMClientError("connection_failed", "LLM 重试仍失败");
      } finally {
        admission.release();
      }
    } finally {
      LLMClient.releaseProbe(breakerKey, isProbe);
    }
  }

  /** Streaming chat — yields text chunks as they arrive */
  async *chatStream(
    messages: Message[],
    options: ChatOptions = {}
  ): AsyncGenerator<string> {
    const requestBody = this.buildRequestBody(messages, options, true);
    const workload = LLMClient.resolveWorkload(options);
    const breakerKey = LLMClient.breakerKey(this.#configRaw.baseUrl, workload);
    const isProbe = LLMClient.acquireBreaker(breakerKey);
    try {
      const admission = LLMClient.acquireProviderAdmission(this.#configRaw.baseUrl, workload);
      try {
        // `chat()` 一开头就查熔断，这里原先不查 —— 同一个熔断，两条路两种待遇：
        // 跳闸之后流式调用照样往外发请求，等 fetch 自己失败才知道。
        if (options.signal?.aborted) throw new LLMClientError("timeout", "LLM request cancelled");
        const controller = new AbortController();
        let timedOut = false;
        let rejectDeadline!: (reason: LLMClientError) => void;
        const deadline = new Promise<never>((_resolve, reject) => {
          rejectDeadline = reject;
        });
        const abortFromCaller = () => {
          controller.abort();
          rejectDeadline(new LLMClientError("timeout", "LLM request cancelled"));
        };
        options.signal?.addEventListener("abort", abortFromCaller, { once: true });
        const timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          rejectDeadline(new LLMClientError("timeout", "LLM request timed out"));
        }, options.timeout ?? 300000);

        let reader: SuccessResponseReader | undefined;
        let finished = false;
        try {
        let resp: Response;
        try {
          resp = await Promise.race([fetch(`${this.#configRaw.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.#configRaw.apiKey}`,
            },
            body: requestBody,
            signal: controller.signal,
          }), deadline]);
        } catch (err: unknown) {
          // 超时 = 生成慢（非不可用），不触发熔断；仅真连接错误熔断
          const isTimeout = timedOut
            || options.signal?.aborted
            || (err instanceof LLMClientError && err.code === "timeout")
            || (err instanceof Error && err.name === "AbortError");
          if (isTimeout && options.signal?.aborted) {
            throw new LLMClientError("timeout", "LLM request cancelled");
          }
          if (!isTimeout) LLMClient.tripBreaker(breakerKey);
          throw new LLMClientError(
            isTimeout ? "timeout" : "connection_failed",
            isTimeout ? "LLM 请求超时" : "LLM 连接失败",
          );
        }
        if (!resp.ok) {
          if (resp.body) cancelResponseBody(resp.body);
          throw new LLMClientError("http_error", `LLM API returned HTTP ${resp.status}`, resp.status);
        }

        LLMClient.closeBreaker(breakerKey);

        if (!resp.body) throw invalidResponse();
        if (declaredBodyExceedsLimit(resp.headers, MAX_STREAM_RESPONSE_BODY_BYTES)) {
          cancelResponseBody(resp.body);
          throw invalidResponse();
        }
        try {
          reader = resp.body.getReader();
        } catch {
          cancelResponseBody(resp.body);
          throw invalidResponse();
        }

        if (!reader) throw invalidResponse();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const encoder = new TextEncoder();
        let observedBytes = 0;
        let pendingLineBytes = 0;
        let buffer = "";
        let eventData: string[] = [];
        let eventDataBytes = 0;

        const clearEvent = () => {
          eventData = [];
          eventDataBytes = 0;
        };
        const dispatchEvent = (): { done: boolean; content?: string } => {
          if (eventData.length === 0) return { done: false };
          const data = eventData.join("\n");
          clearEvent();
          if (data === "") return { done: false };
          if (data === "[DONE]") return { done: true };
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            throw invalidResponse();
          }
          if (typeof payload !== "object" || payload === null) throw invalidResponse();
          const { choices } = payload as { choices?: unknown };
          if (!Array.isArray(choices) || choices.length === 0) throw invalidResponse();
          const choice = choices[0];
          if (typeof choice !== "object" || choice === null) throw invalidResponse();
          const { delta } = choice as { delta?: unknown };
          if (typeof delta !== "object" || delta === null) throw invalidResponse();
          const { content } = delta as { content?: unknown };
          if (content === undefined) return { done: false };
          if (typeof content !== "string") throw invalidResponse();
          return { done: false, content };
        };
        const consumeLine = (rawLine: string): { done: boolean; content?: string } | undefined => {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (line === "") return dispatchEvent();
          if (line.startsWith(":")) return undefined;
          const separator = line.indexOf(":");
          if (separator < 0 || line.slice(0, separator) !== "data") return undefined;
          let value = line.slice(separator + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          const valueBytes = encoder.encode(value).byteLength + (eventData.length > 0 ? 1 : 0);
          if (valueBytes > MAX_PENDING_SSE_BYTES - eventDataBytes) throw invalidResponse();
          eventDataBytes += valueBytes;
          eventData.push(value);
          return undefined;
        };
        const observePendingLine = (value: Uint8Array) => {
          for (const byte of value) {
            if (byte === 0x0a) pendingLineBytes = 0;
            else if (++pendingLineBytes > MAX_PENDING_SSE_BYTES) throw invalidResponse();
          }
        };

        while (true) {
          let done: boolean;
          let value: Uint8Array | undefined;
          try {
            ({ done, value } = await Promise.race([reader.read(), deadline]));
          } catch (error) {
            const isTimeout = timedOut
              || options.signal?.aborted
              || (error instanceof LLMClientError && error.code === "timeout")
              || (error instanceof Error && error.name === "AbortError");
            if (isTimeout) {
              throw new LLMClientError(
                "timeout",
                options.signal?.aborted ? "LLM request cancelled" : "LLM request timed out",
              );
            }
            throw error;
          }
          if (done) break;
          if (!value) continue;
          if (value.byteLength > MAX_STREAM_RESPONSE_BODY_BYTES - observedBytes) throw invalidResponse();
          observedBytes += value.byteLength;
          observePendingLine(value);
          try {
            buffer += decoder.decode(value, { stream: true });
          } catch {
            throw invalidResponse();
          }

          while (true) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const outcome = consumeLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (outcome?.content) yield outcome.content;
            if (outcome?.done) {
              finished = true;
              return;
            }
          }
        }
        try {
          buffer += decoder.decode();
        } catch {
          throw invalidResponse();
        }
        if (buffer !== "") {
          const outcome = consumeLine(buffer);
          buffer = "";
          if (outcome?.content) yield outcome.content;
          if (outcome?.done) {
            finished = true;
            return;
          }
        }
        const finalOutcome = dispatchEvent();
        if (finalOutcome.content) yield finalOutcome.content;
        finished = true;
        } finally {
          clearTimeout(timeoutId);
          options.signal?.removeEventListener("abort", abortFromCaller);
          if (reader) {
            if (finished) {
              try { reader.releaseLock(); } catch { /* reader was already released */ }
            } else {
              cancelAndReleaseReader(reader);
            }
          }
        }
      } finally {
        admission.release();
      }
    } finally {
      LLMClient.releaseProbe(breakerKey, isProbe);
    }
  }
}
