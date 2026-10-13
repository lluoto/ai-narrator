import { describe, expect, it } from "bun:test";
import {
  COMPILER_HTTP_PDF_BODY_LIMIT_BYTES,
  handleCompiledModuleHttpRequest,
  type CompiledModuleHttpDependencies,
} from "../api/compiled-module-http";
import { PDF_PREPARE_INGRESS_LIMITS, PdfPrepareIngressAdmission } from "../api/compiler-pdf-ingress-admission";
import { __replacePdfPrepareWorkerForTest } from "../compiler/compiler-pdf-prepare-isolation";

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

function trackedPdfBody(mode: "complete" | "stall" = "complete"): { body: ReadableStream<Uint8Array>; pulls(): number } {
  let pulls = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (mode === "stall") return new Promise<void>(() => {});
        controller.enqueue(new TextEncoder().encode("not-a-pdf"));
        controller.close();
      },
    }),
    pulls: () => pulls,
  };
}

/**
 * Bun may ask an underlying source for a chunk while constructing `Request`.
 * Count `getReader` instead: it is the first handler-controlled body pull and
 * is therefore the stable assertion for an immediate ingress rejection.
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
    }),
    readerPulls: () => readerPulls,
  };
}

function dependencies(
  ingress: PdfPrepareIngressAdmission | undefined,
  principalId: string,
): CompiledModuleHttpDependencies {
  return {
    createSession: () => { throw new Error("session creation is outside this ingress test"); },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "pdf-ingress-test",
    ...(ingress ? { pdfPrepareIngressAdmission: ingress } : {}),
    authenticateCompilerRequest: () => ({
      status: "authenticated" as const,
      principal: { id: principalId, role: "operator" as const },
    }),
  };
}

function prepareRequest(
  moduleId: string | undefined,
  body: ReadableStream<Uint8Array>,
  extra: { contentType?: string; contentLength?: string; signal?: AbortSignal; query?: string } = {},
): Request {
  const params = new URLSearchParams();
  if (moduleId !== undefined) params.set("moduleId", moduleId);
  if (extra.query) params.set("declaredPrincipal", extra.query);
  return new Request(`http://test/api/compiler/prepare?${params}`, {
    method: "POST",
    headers: {
      "Content-Type": extra.contentType ?? "application/pdf",
      ...(extra.contentLength === undefined ? {} : { "Content-Length": extra.contentLength }),
      // This attacker-controlled header must not become an admission key.
      "X-Principal": extra.query ?? "untrusted",
    },
    body,
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
}

describe("compiled prepare PDF ingress admission", () => {
  it("keeps the production controller fixed at five global slots and two per host principal", () => {
    expect(PDF_PREPARE_INGRESS_LIMITS).toEqual({ globalLimit: 5, perPrincipalLimit: 2, retryAfterSeconds: 1 });
    const ingress = new PdfPrepareIngressAdmission();
    const a1 = ingress.acquire("host-a");
    const a2 = ingress.acquire("host-a");
    const a3 = ingress.acquire("host-a");
    expect(a1.status).toBe("admitted");
    expect(a2.status).toBe("admitted");
    expect(a3).toMatchObject({ status: "busy", retryAfterSeconds: 1 });
    const b1 = ingress.acquire("host-b");
    const c1 = ingress.acquire("host-c");
    const d1 = ingress.acquire("host-d");
    expect(b1.status).toBe("admitted");
    expect(c1.status).toBe("admitted");
    expect(d1.status).toBe("admitted");
    expect(ingress.acquire("host-e")).toMatchObject({ status: "busy", retryAfterSeconds: 1 });
    if (a1.status === "admitted") { a1.lease.release(); a1.lease.release(); }
    expect(ingress.acquire("host-e").status).toBe("admitted");
    if (a2.status === "admitted") a2.lease.release();
    // Reacquiring the same key after its count reaches zero proves stale
    // principal accounting cannot retain a phantom per-principal slot.
    expect(ingress.acquire("host-a").status).toBe("admitted");
  });

  it("uses the authenticated host principal, rejects before body pull, and keeps the ingress lease through worker completion", async () => {
    const ingress = new PdfPrepareIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1 });
    const unblockWorker = deferred();
    const restoreWorker = __replacePdfPrepareWorkerForTest(async () => {
      await unblockWorker.promise;
      return { status: "unavailable" };
    });
    const first = trackedPdfBody();
    const secondSameHost = trackedPdfBody();
    const secondHost = trackedPdfBody();
    const thirdHost = trackedPdfBody();
    let firstPending: Promise<Response | null> | undefined;
    let secondPending: Promise<Response | null> | undefined;
    try {
      const firstRequest = readerTrackedRequest(prepareRequest("one", first.body, { query: "body-claims-a" }));
      firstPending = handleCompiledModuleHttpRequest(
        firstRequest.request,
        dependencies(ingress, "trusted-host-a"),
      );
      await eventually(() => firstRequest.readerPulls() > 0);

      const samePrincipalRequest = readerTrackedRequest(prepareRequest("different-module", secondSameHost.body, { query: "body-claims-b" }));
      const samePrincipalResponse = await responseWithin(handleCompiledModuleHttpRequest(
        samePrincipalRequest.request,
        dependencies(ingress, "trusted-host-a"),
      ));
      expect(samePrincipalResponse?.status).toBe(429);
      expect(samePrincipalResponse?.headers.get("Retry-After")).toBe("1");
      expect(await samePrincipalResponse?.json()).toMatchObject({ error: { stage: "prepare", code: "PREPARE_INGRESS_BUSY" } });
      expect(samePrincipalRequest.readerPulls()).toBe(0);

      const secondRequest = readerTrackedRequest(prepareRequest("one", secondHost.body, { query: "body-claims-a" }));
      secondPending = handleCompiledModuleHttpRequest(
        secondRequest.request,
        dependencies(ingress, "trusted-host-b"),
      );
      await eventually(() => secondRequest.readerPulls() > 0);

      const globalRequest = readerTrackedRequest(prepareRequest("one", thirdHost.body, { query: "body-claims-c" }));
      const globalResponse = await responseWithin(handleCompiledModuleHttpRequest(
        globalRequest.request,
        dependencies(ingress, "trusted-host-c"),
      ));
      expect(globalResponse?.status).toBe(429);
      expect(globalResponse?.headers.get("Retry-After")).toBe("1");
      expect(await globalResponse?.json()).toMatchObject({ error: { stage: "prepare", code: "PREPARE_INGRESS_BUSY" } });
      expect(globalRequest.readerPulls()).toBe(0);
    } finally {
      unblockWorker.resolve();
      await Promise.all([firstPending, secondPending].filter((pending): pending is Promise<Response | null> => !!pending));
      restoreWorker();
    }
  });

  it("uses one module-shared production fallback across requests and frees it after completion", async () => {
    const unblockWorker = deferred();
    const restoreWorker = __replacePdfPrepareWorkerForTest(async () => {
      await unblockWorker.promise;
      return { status: "unavailable" };
    });
    const first = readerTrackedRequest(prepareRequest("fallback-one", trackedPdfBody().body));
    const second = readerTrackedRequest(prepareRequest("fallback-two", trackedPdfBody().body));
    const rejected = readerTrackedRequest(prepareRequest("fallback-three", trackedPdfBody().body));
    let firstPending: Promise<Response | null> | undefined;
    let secondPending: Promise<Response | null> | undefined;
    try {
      // Deliberately omit pdfPrepareIngressAdmission. Both requests must reach
      // the same module-owned fallback and consume its two host-principal
      // slots, not two freshly constructed controllers.
      firstPending = handleCompiledModuleHttpRequest(first.request, dependencies(undefined, "fallback-host"));
      await eventually(() => first.readerPulls() > 0);
      secondPending = handleCompiledModuleHttpRequest(second.request, dependencies(undefined, "fallback-host"));
      await eventually(() => second.readerPulls() > 0);

      const busy = await responseWithin(handleCompiledModuleHttpRequest(
        rejected.request,
        dependencies(undefined, "fallback-host"),
      ));
      expect(busy?.status).toBe(429);
      expect(busy?.headers.get("Retry-After")).toBe("1");
      expect(await busy?.json()).toMatchObject({ error: { stage: "prepare", code: "PREPARE_INGRESS_BUSY" } });
      expect(rejected.readerPulls()).toBe(0);
      unblockWorker.resolve();
      await Promise.all([firstPending, secondPending].filter((pending): pending is Promise<Response | null> => !!pending));

      const reusable = readerTrackedRequest(prepareRequest("fallback-reusable", trackedPdfBody().body));
      const reused = await responseWithin(handleCompiledModuleHttpRequest(
        reusable.request,
        dependencies(undefined, "fallback-host"),
      ));
      expect(reusable.readerPulls()).toBeGreaterThan(0);
      expect(reused?.status).toBe(503);
    } finally {
      unblockWorker.resolve();
      await Promise.all([firstPending, secondPending].filter((pending): pending is Promise<Response | null> => !!pending));
      restoreWorker();
    }
  }, 10_000);

  it("releases an aborted or failed request so its slot can be reused", async () => {
    const ingress = new PdfPrepareIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1 });
    const restoreWorker = __replacePdfPrepareWorkerForTest(async () => ({ status: "unavailable" }));
    const abort = new AbortController();
    const stalled = trackedPdfBody("stall");
    const stalledRequest = readerTrackedRequest(prepareRequest("abort", stalled.body, { signal: abort.signal }));
    const firstPending = handleCompiledModuleHttpRequest(
      stalledRequest.request,
      dependencies(ingress, "trusted-host"),
    );
    try {
      await eventually(() => stalledRequest.readerPulls() > 0);
      abort.abort();
      const aborted = await responseWithin(firstPending);
      expect(aborted?.status).toBe(408);
      expect(await aborted?.json()).toMatchObject({ error: { stage: "prepare", code: "REQUEST_BODY_ABORTED" } });

      const failed = trackedPdfBody();
      const failedRequest = readerTrackedRequest(prepareRequest("fails", failed.body));
      const failedResponse = await responseWithin(handleCompiledModuleHttpRequest(
        failedRequest.request,
        dependencies(ingress, "trusted-host"),
      ));
      expect(failedRequest.readerPulls()).toBeGreaterThan(0);
      expect(failedResponse?.status).toBe(503);

      const reusableAbort = new AbortController();
      const reusable = trackedPdfBody("stall");
      const reusableRequest = readerTrackedRequest(prepareRequest("reusable", reusable.body, { signal: reusableAbort.signal }));
      const reusablePending = handleCompiledModuleHttpRequest(
        reusableRequest.request,
        dependencies(ingress, "trusted-host"),
      );
      try {
        await eventually(() => reusableRequest.readerPulls() > 0);
      } finally {
        reusableAbort.abort();
        await reusablePending;
      }
    } finally {
      restoreWorker();
    }
  }, 10_000);

  it("does not consume a global slot for invalid PDF shape before touching its body", async () => {
    const ingress = new PdfPrepareIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1 });
    const holderAbort = new AbortController();
    const holder = trackedPdfBody("stall");
    const holderRequest = readerTrackedRequest(prepareRequest("holder", holder.body, { signal: holderAbort.signal }));
    const holderPending = handleCompiledModuleHttpRequest(
      holderRequest.request,
      dependencies(ingress, "trusted-host"),
    );
    await eventually(() => holderRequest.readerPulls() > 0);
    const wrongType = trackedPdfBody();
    const missingModule = trackedPdfBody();
    const oversizeDeclared = trackedPdfBody();
    try {
      const unsupportedRequest = readerTrackedRequest(prepareRequest("ignored", wrongType.body, { contentType: "application/json" }));
      const unsupported = await responseWithin(handleCompiledModuleHttpRequest(
        unsupportedRequest.request,
        dependencies(ingress, "another-host"),
      ));
      expect(unsupported?.status).toBe(415);
      expect(unsupportedRequest.readerPulls()).toBe(0);

      const missingRequest = readerTrackedRequest(prepareRequest(undefined, missingModule.body));
      const missing = await responseWithin(handleCompiledModuleHttpRequest(
        missingRequest.request,
        dependencies(ingress, "another-host"),
      ));
      expect(missing?.status).toBe(400);
      expect(missingRequest.readerPulls()).toBe(0);

      const oversizeRequest = readerTrackedRequest(prepareRequest("ignored", oversizeDeclared.body, {
        contentLength: String(COMPILER_HTTP_PDF_BODY_LIMIT_BYTES + 1),
      }));
      const oversize = await responseWithin(handleCompiledModuleHttpRequest(
        oversizeRequest.request,
        dependencies(ingress, "another-host"),
      ));
      expect(oversize?.status).toBe(413);
      expect(oversizeRequest.readerPulls()).toBe(0);
    } finally {
      holderAbort.abort();
      await holderPending;
    }
  });
});
