import { describe, expect, it } from "bun:test";
import { handleCompiledModuleHttpRequest, COMPILER_HTTP_BODY_LIMIT_BYTES } from "../api/compiled-module-http";

function dependencies(bodyReadDeadlineMs?: number) {
  return {
    createSession: () => { throw new Error("session creation is outside this body-read test"); },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "body-read-test",
    authenticateCompilerRequest: () => ({ status: "authenticated" as const, principal: { id: "body-read-test", role: "operator" as const } }),
    ...(bodyReadDeadlineMs === undefined ? {} : { bodyReadDeadlineMs }),
  };
}

function stalledStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
  });
}

function observedOversizeStream(): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return;
      sent = true;
      controller.enqueue(new Uint8Array(COMPILER_HTTP_BODY_LIMIT_BYTES + 1));
    },
    // A hostile source may never acknowledge cancellation. The HTTP handler
    // must still make its refusal visible and release the reader lock.
    cancel: () => new Promise<void>(() => {}),
  });
}

function malformedUtf8Json(): Uint8Array {
  const encoder = new TextEncoder();
  const prefix = encoder.encode('{"preparedArtifactId":"artifact-');
  const suffix = encoder.encode('","preparedQueueHash":"queue","hints":{},"presentationReviewId":"review"}');
  const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
  bytes.set(prefix);
  bytes[prefix.length] = 0xc3; // an incomplete two-byte UTF-8 sequence
  bytes.set(suffix, prefix.length + 1);
  return bytes;
}

async function responseWithin<T>(pending: Promise<T>, timeoutMs = 250): Promise<T> {
  const timedOut = Symbol("body read did not settle");
  const result = await Promise.race([pending, Bun.sleep(timeoutMs).then(() => timedOut)]);
  expect(result).not.toBe(timedOut);
  return result as T;
}

describe("compiled module HTTP body-read hardening", () => {
  it("returns a JSON body-abort refusal promptly when the request signal aborts a stalled body", async () => {
    const abort = new AbortController();
    const request = new Request("http://test/api/compiler/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stalledStream(),
      signal: abort.signal,
    });
    const pending = handleCompiledModuleHttpRequest(request, dependencies());
    // Let the async authenticator boundary complete and the reader enter its
    // pending read before aborting; a one-time pre-read signal check is not
    // sufficient to satisfy this contract.
    await Bun.sleep(20);
    abort.abort();

    const response = await responseWithin(pending);
    expect(response?.status).toBe(408);
    expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "REQUEST_BODY_ABORTED" } });
  });

  it("applies the server-owned absolute body deadline to the shared PDF reader", async () => {
    const response = await responseWithin(handleCompiledModuleHttpRequest(
      new Request("http://test/api/compiler/prepare?moduleId=stalled-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: stalledStream(),
      }),
      dependencies(40),
    ));
    expect(response?.status).toBe(408);
    expect(await response?.json()).toMatchObject({ error: { stage: "prepare", code: "REQUEST_BODY_TIMEOUT" } });
  });

  it("does not await a hostile cancellation after an observed JSON size overrun", async () => {
    const response = await responseWithin(handleCompiledModuleHttpRequest(
      new Request("http://test/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: observedOversizeStream(),
      }),
      dependencies(),
    ));
    expect(response?.status).toBe(413);
    expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "BODY_TOO_LARGE" } });
  });

  it("rejects malformed UTF-8 before JSON parsing can normalize it with replacement characters", async () => {
    const response = await handleCompiledModuleHttpRequest(
      new Request("http://test/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: malformedUtf8Json(),
      }),
      dependencies(),
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "JSON_INVALID" } });
  });
});
