import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  COMPILER_HTTP_BODY_LIMIT_BYTES,
  handleCompiledModuleHttpRequest,
  type CompiledModuleHttpDependencies,
} from "../api/compiled-module-http";
import {
  COMPILER_JSON_INGRESS_LIMITS,
  CompilerJsonIngressAdmission,
} from "../api/compiler-json-ingress-admission";
import { CompilerAutoAdmissionController } from "../api/compiler-auto-admission";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { prepareCompiler } from "../compiler/compiler-api";
import type { LLMLike } from "../llm/client";
import { PAGES } from "./helpers/compiled-module-http-fixture";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

async function responseWithin(pending: Promise<Response | null>, timeoutMs = 300): Promise<Response | null> {
  const timeout = Symbol("request did not settle");
  const result = await Promise.race([pending, Bun.sleep(timeoutMs).then(() => timeout)]);
  expect(result).not.toBe(timeout);
  return result as Response | null;
}

function stalledJsonBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
  });
}

function gatedJsonBody(): { body: ReadableStream<Uint8Array>; finish(): void } {
  const gate = deferred();
  let sent = false;
  return {
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent) return;
        sent = true;
        await gate.promise;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }),
    finish: gate.resolve,
  };
}

function jsonValueBody(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

class DeferredAutoResolveLlm implements LLMLike {
  readonly #firstCall = deferred();
  #settled = false;
  #resolve!: (value: string) => void;
  readonly #pending = new Promise<string>((resolve) => { this.#resolve = resolve; });

  async chat(): Promise<string> {
    this.#firstCall.resolve();
    return this.#pending;
  }

  async waitForFirstCall(timeoutMs = 2_000): Promise<void> {
    const timeout = Symbol("provider was not called");
    const result = await Promise.race([this.#firstCall.promise, Bun.sleep(timeoutMs).then(() => timeout)]);
    expect(result).not.toBe(timeout);
  }

  resolve(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve('{"proposals":[]}');
  }
}

/**
 * Bun may pull a source while creating a Request. Count `getReader`: it is
 * the first handler-controlled body operation and is stable for admission.
 */
function readerTrackedRequest(request: Request): { request: Request; readerPulls(): number } {
  let readerPulls = 0;
  return {
    request: new Proxy(request, {
      get(target, property) {
        if (property !== "body") return Reflect.get(target, property, target);
        const body = target.body;
        if (!body) return null;
        return new Proxy(body, {
          get(stream, streamProperty) {
            if (streamProperty !== "getReader") return Reflect.get(stream, streamProperty, stream);
            return () => {
              readerPulls++;
              return stream.getReader();
            };
          },
        });
      },
    }) as Request,
    readerPulls: () => readerPulls,
  };
}

function brokenReaderRequest(pathname: string): Request {
  const request = new Request(`http://test${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return new Proxy(request, {
    get(target, property) {
      if (property !== "body") return Reflect.get(target, property, target);
      return { getReader: () => { throw new Error("reader is broken"); } };
    },
  }) as Request;
}

function dependencies(
  ingress: CompilerJsonIngressAdmission | undefined,
  principalId: string,
): CompiledModuleHttpDependencies {
  return {
    createSession: () => { throw new Error("session creation is outside this ingress test"); },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "json-ingress-test",
    ...(ingress ? { jsonIngressAdmission: ingress } : {}),
    authenticateCompilerRequest: () => ({
      status: "authenticated" as const,
      principal: { id: principalId, role: "operator" as const },
    }),
  };
}

function jsonRequest(
  pathname: string,
  body: ReadableStream<Uint8Array>,
  options: { contentType?: string; contentLength?: string; signal?: AbortSignal; query?: string; claimedPrincipal?: string } = {},
): Request {
  return new Request(`http://test${pathname}${options.query ? `?${options.query}` : ""}`, {
    method: "POST",
    headers: {
      "Content-Type": options.contentType ?? "application/json",
      "X-Claimed-Principal": options.claimedPrincipal ?? "untrusted-request-input",
      ...(options.contentLength === undefined ? {} : { "Content-Length": options.contentLength }),
    },
    body,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

describe("compiled JSON ingress admission", () => {
  it("uses fixed production limits and an idempotent, zero-cleaning lease", () => {
    expect(COMPILER_JSON_INGRESS_LIMITS).toEqual({ globalLimit: 8, perPrincipalLimit: 2, retryAfterSeconds: 1 });
    for (const limits of [
      { globalLimit: 0, perPrincipalLimit: 1, retryAfterSeconds: 1 },
      { globalLimit: 1, perPrincipalLimit: 0, retryAfterSeconds: 1 },
      { globalLimit: 1, perPrincipalLimit: 2, retryAfterSeconds: 1 },
      { globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 0 },
    ]) expect(() => new CompilerJsonIngressAdmission(limits)).toThrow();

    const ingress = new CompilerJsonIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const first = ingress.acquire("principal-a");
    expect(first.status).toBe("admitted");
    expect(ingress.acquire("principal-a")).toMatchObject({ status: "busy", retryAfterSeconds: 1 });
    if (first.status === "admitted") {
      first.lease.release();
      first.lease.release();
    }
    // A zero-count principal must not retain a phantom per-principal slot.
    expect(ingress.acquire("principal-a").status).toBe("admitted");
  });

  it("shares one authenticated-principal budget across all JSON compiler routes and refuses busy requests before getReader", async () => {
    const ingress = new CompilerJsonIngressAdmission({ globalLimit: 4, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const abort = new AbortController();
    const holder = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), {
      signal: abort.signal,
      query: "moduleId=holder-artifact&tenant=trusted-a",
      claimedPrincipal: "attacker-claimed-holder",
    }));
    const holding = handleCompiledModuleHttpRequest(holder.request, dependencies(ingress, "trusted-host"));
    try {
      await eventually(() => holder.readerPulls() > 0);
      for (const [pathname, stage, attackerArtifact] of [
        ["/api/compiler/auto-resolve", "resolve", "auto-attacker-artifact"],
        ["/api/compiler/presentation-reviews", "project", "review-attacker-artifact"],
        ["/api/compiler/presentation-workbench", "project", "workbench-attacker-artifact"],
      ] as const) {
        const rejected = readerTrackedRequest(jsonRequest(pathname, jsonValueBody({
          preparedArtifactId: attackerArtifact,
          preparedQueueHash: "attacker-selected-body-value",
        }), {
          query: `moduleId=${attackerArtifact}&claimedPrincipal=attacker-query-value`,
          claimedPrincipal: `attacker-header-${attackerArtifact}`,
        }));
        const response = await responseWithin(handleCompiledModuleHttpRequest(rejected.request, dependencies(ingress, "trusted-host")));
        expect(response?.status).toBe(429);
        expect(response?.headers.get("Retry-After")).toBe("1");
        expect(await response?.json()).toEqual({ error: { stage, code: "COMPILER_JSON_INGRESS_BUSY", message: "compiler JSON ingress is at capacity" } });
        expect(rejected.readerPulls()).toBe(0);
      }
    } finally {
      abort.abort();
      await holding;
    }
  });

  it("enforces global capacity across different authenticated principals without admitting request-selected keys", async () => {
    const ingress = new CompilerJsonIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const abortA = new AbortController();
    const abortB = new AbortController();
    const first = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { signal: abortA.signal }));
    const second = readerTrackedRequest(jsonRequest("/api/compiler/presentation-workbench", stalledJsonBody(), { signal: abortB.signal }));
    const firstPending = handleCompiledModuleHttpRequest(first.request, dependencies(ingress, "trusted-a"));
    const secondPending = handleCompiledModuleHttpRequest(second.request, dependencies(ingress, "trusted-b"));
    try {
      await eventually(() => first.readerPulls() > 0 && second.readerPulls() > 0);
      const rejected = readerTrackedRequest(jsonRequest("/api/compiler/auto-resolve", stalledJsonBody()));
      const response = await responseWithin(handleCompiledModuleHttpRequest(rejected.request, dependencies(ingress, "trusted-c")));
      expect(response?.status).toBe(429);
      expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "COMPILER_JSON_INGRESS_BUSY" } });
      expect(rejected.readerPulls()).toBe(0);
    } finally {
      abortA.abort();
      abortB.abort();
      await Promise.all([firstPending, secondPending]);
    }
  });

  it("keeps cheap header refusals ahead of capacity, retains an async body lease, and releases aborts and reader errors", async () => {
    const ingress = new CompilerJsonIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const fullAbort = new AbortController();
    const full = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { signal: fullAbort.signal }));
    const fullPending = handleCompiledModuleHttpRequest(full.request, dependencies(ingress, "trusted-holder"));
    await eventually(() => full.readerPulls() > 0);
    const wrongType = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { contentType: "text/plain" }));
    const invalidLength = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { contentLength: "not-a-length" }));
    const oversizedLength = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { contentLength: String(COMPILER_HTTP_BODY_LIMIT_BYTES + 1) }));
    try {
      const wrongTypeResponse = await responseWithin(handleCompiledModuleHttpRequest(wrongType.request, dependencies(ingress, "trusted-a")));
      const invalidLengthResponse = await responseWithin(handleCompiledModuleHttpRequest(invalidLength.request, dependencies(ingress, "trusted-a")));
      const oversizedLengthResponse = await responseWithin(handleCompiledModuleHttpRequest(oversizedLength.request, dependencies(ingress, "trusted-a")));
      expect(wrongTypeResponse?.status).toBe(415);
      expect(invalidLengthResponse?.status).toBe(400);
      expect(oversizedLengthResponse?.status).toBe(413);
      expect(wrongType.readerPulls()).toBe(0);
      expect(invalidLength.readerPulls()).toBe(0);
      expect(oversizedLength.readerPulls()).toBe(0);
    } finally {
      fullAbort.abort();
      await fullPending;
    }

    const gated = gatedJsonBody();
    const first = readerTrackedRequest(jsonRequest("/api/compiler/resolve", gated.body));
    const firstPending = handleCompiledModuleHttpRequest(first.request, dependencies(ingress, "trusted-a"));
    await eventually(() => first.readerPulls() > 0);
    const held = readerTrackedRequest(jsonRequest("/api/compiler/presentation-reviews", stalledJsonBody()));
    const heldResponse = await responseWithin(handleCompiledModuleHttpRequest(held.request, dependencies(ingress, "trusted-b")));
    expect(heldResponse?.status).toBe(429);
    expect(held.readerPulls()).toBe(0);
    gated.finish();
    expect((await firstPending)?.status).toBe(400);

    const abort = new AbortController();
    const aborted = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { signal: abort.signal }));
    const abortedPending = handleCompiledModuleHttpRequest(aborted.request, dependencies(ingress, "trusted-a"));
    await eventually(() => aborted.readerPulls() > 0);
    abort.abort();
    expect((await abortedPending)?.status).toBe(408);

    const broken = await responseWithin(handleCompiledModuleHttpRequest(brokenReaderRequest("/api/compiler/resolve"), dependencies(ingress, "trusted-a")));
    expect(broken?.status).toBe(400);
    const reusableAbort = new AbortController();
    const reusable = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { signal: reusableAbort.signal }));
    const reusablePending = handleCompiledModuleHttpRequest(reusable.request, dependencies(ingress, "trusted-a"));
    try {
      await eventually(() => reusable.readerPulls() > 0);
    } finally {
      reusableAbort.abort();
      await reusablePending;
    }
  });

  it("holds JSON admission after auto-resolve has parsed its body until the provider and durable admission settle", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-json-ingress-auto-"));
    const ingress = new CompilerJsonIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const llm = new DeferredAutoResolveLlm();
    let pending: Promise<Response | null> | undefined;
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await prepareCompiler({
        kind: "synthetic_pages",
        moduleId: "json-ingress-auto",
        sourceDescriptor: "json-ingress-auto",
        pages: PAGES,
      });
      if (prepared.status === "refused") throw new Error(prepared.message);
      const saved = catalog.savePrepared(prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const durableAdmission = new CompilerAutoAdmissionController({
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
      });
      const autoRequest = readerTrackedRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: saved.value.id,
          preparedQueueHash: prepared.identity.preparedQueueHash,
        }),
      }));
      pending = handleCompiledModuleHttpRequest(autoRequest.request, {
        ...dependencies(ingress, "trusted-auto"),
        catalog,
        autoCompiler: {
          llm,
          policy: { policyId: "json-ingress-auto-test-v1", rightsStatus: "user_provided" },
          producer: { providerFingerprint: "test:json-ingress", modelFingerprint: "test:json-ingress" },
          limits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxResponseTokens: 2_400 },
          maxProposalRounds: 1,
          admission: durableAdmission,
        },
      });
      await llm.waitForFirstCall();
      // The provider call proves JSON parsing and catalog replay completed;
      // the following refusal therefore observes post-body asynchronous work.
      expect(autoRequest.readerPulls()).toBeGreaterThan(0);
      const competing = readerTrackedRequest(jsonRequest("/api/compiler/presentation-workbench", jsonValueBody({
        preparedArtifactId: "attacker-artifact",
        preparedQueueHash: "attacker-queue",
      }), {
        query: "artifact=attacker-query",
        claimedPrincipal: "attacker-header",
      }));
      const blocked = await responseWithin(handleCompiledModuleHttpRequest(competing.request, dependencies(ingress, "trusted-other")));
      expect(blocked?.status).toBe(429);
      expect(await blocked?.json()).toMatchObject({ error: { stage: "project", code: "COMPILER_JSON_INGRESS_BUSY" } });
      expect(competing.readerPulls()).toBe(0);

      llm.resolve();
      expect((await pending)?.status).toBe(200);
      pending = undefined;

      const reusableAbort = new AbortController();
      const reusable = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { signal: reusableAbort.signal }));
      const reusablePending = handleCompiledModuleHttpRequest(reusable.request, dependencies(ingress, "trusted-other"));
      try {
        await eventually(() => reusable.readerPulls() > 0);
      } finally {
        reusableAbort.abort();
        await reusablePending;
      }
    } finally {
      llm.resolve();
      if (pending) await pending;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("retains JSON admission through a whole-job deadline background drain until an abort-ignoring provider settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-json-ingress-deadline-drain-"));
    const ingress = new CompilerJsonIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const llm = new DeferredAutoResolveLlm();
    let firstPending: Promise<Response | null> | undefined;
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await prepareCompiler({
        kind: "synthetic_pages",
        moduleId: "json-ingress-deadline-drain",
        sourceDescriptor: "json-ingress-deadline-drain",
        pages: PAGES,
      });
      if (prepared.status === "refused") throw new Error(prepared.message);
      const saved = catalog.savePrepared(prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const durableAdmission = new CompilerAutoAdmissionController({
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        leaseTtlMs: 1_000,
        wholeJobDeadlineMs: 50,
        hardDrainMs: 1_000,
      });
      const first = readerTrackedRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: saved.value.id,
          preparedQueueHash: prepared.identity.preparedQueueHash,
        }),
      }));
      firstPending = handleCompiledModuleHttpRequest(first.request, {
        ...dependencies(ingress, "trusted-deadline-owner"),
        catalog,
        autoCompiler: {
          llm,
          policy: { policyId: "json-ingress-deadline-drain-test-v1", rightsStatus: "user_provided" },
          producer: { providerFingerprint: "test:json-ingress-deadline", modelFingerprint: "test:json-ingress-deadline" },
          limits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxResponseTokens: 2_400 },
          maxProposalRounds: 1,
          admission: durableAdmission,
        },
      });
      await llm.waitForFirstCall();
      expect(first.readerPulls()).toBeGreaterThan(0);
      const deadlineResponse = await firstPending;
      firstPending = undefined;
      expect(deadlineResponse?.status).toBe(503);
      expect(await deadlineResponse?.json()).toMatchObject({ error: { stage: "resolve", code: "AUTO_ADMISSION_DEADLINE_EXCEEDED" } });

      // The HTTP result has been sent, but this provider deliberately ignores
      // cancellation and is still in the durable admission's background drain.
      const competing = readerTrackedRequest(jsonRequest("/api/compiler/resolve", jsonValueBody({
        preparedArtifactId: "attacker-artifact",
        preparedQueueHash: "attacker-queue",
      }), {
        query: "artifact=attacker-query",
        claimedPrincipal: "attacker-header",
      }));
      const blocked = await responseWithin(handleCompiledModuleHttpRequest(competing.request, dependencies(ingress, "trusted-competing-principal")));
      expect(blocked?.status).toBe(429);
      expect(await blocked?.json()).toMatchObject({ error: { stage: "resolve", code: "COMPILER_JSON_INGRESS_BUSY" } });
      expect(competing.readerPulls()).toBe(0);

      llm.resolve();
      await eventually(() => {
        const probe = ingress.acquire("post-deadline-drain-probe");
        if (probe.status !== "admitted") return false;
        probe.lease.release();
        return true;
      }, 2_000);
      const reusableAbort = new AbortController();
      const reusable = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { signal: reusableAbort.signal }));
      const reusablePending = handleCompiledModuleHttpRequest(reusable.request, dependencies(ingress, "trusted-competing-principal"));
      try {
        await eventually(() => reusable.readerPulls() > 0, 2_000);
      } finally {
        reusableAbort.abort();
        await reusablePending;
      }
    } finally {
      llm.resolve();
      if (firstPending) await firstPending;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("uses the module-shared production fallback when no host/test controller is injected", async () => {
    const abortA = new AbortController();
    const abortB = new AbortController();
    const first = readerTrackedRequest(jsonRequest("/api/compiler/resolve", stalledJsonBody(), { signal: abortA.signal }));
    const second = readerTrackedRequest(jsonRequest("/api/compiler/presentation-reviews", stalledJsonBody(), { signal: abortB.signal }));
    const firstPending = handleCompiledModuleHttpRequest(first.request, dependencies(undefined, "production-host"));
    const secondPending = handleCompiledModuleHttpRequest(second.request, dependencies(undefined, "production-host"));
    try {
      await eventually(() => first.readerPulls() > 0 && second.readerPulls() > 0);
      const rejected = readerTrackedRequest(jsonRequest("/api/compiler/presentation-workbench", stalledJsonBody()));
      const response = await responseWithin(handleCompiledModuleHttpRequest(rejected.request, dependencies(undefined, "production-host")));
      expect(response?.status).toBe(429);
      expect(await response?.json()).toMatchObject({ error: { stage: "project", code: "COMPILER_JSON_INGRESS_BUSY" } });
      expect(rejected.readerPulls()).toBe(0);
    } finally {
      abortA.abort();
      abortB.abort();
      await Promise.all([firstPending, secondPending]);
    }
  });
});
