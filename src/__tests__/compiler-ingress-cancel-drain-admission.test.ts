import { describe, expect, it } from "bun:test";
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  handleCompiledModuleHttpRequest,
  type CompiledModuleHttpDependencies,
} from "../api/compiled-module-http";
import { CompilerJsonIngressAdmission } from "../api/compiler-json-ingress-admission";
import { PdfPrepareIngressAdmission } from "../api/compiler-pdf-ingress-admission";
import { CompiledSessionCreationIngressAdmission } from "../api/compiled-session-creation-ingress-admission";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import { __replacePdfPrepareWorkerForTest } from "../compiler/compiler-pdf-prepare-isolation";

const durableRoots = new Set<string>();
afterEach(() => {
  for (const root of durableRoots) rmSync(root, { recursive: true, force: true });
  durableRoots.clear();
});

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
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

/** Count handler getReader calls rather than source pulls, which Bun may prefetch. */
function readerTrackedRequest(request: Request): { request: Request; readerCalls(): number } {
  let readerCalls = 0;
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
              readerCalls++;
              return stream.getReader();
            };
          },
        });
      },
    }) as Request,
    readerCalls: () => readerCalls,
  };
}

function cancelDeferredRequest(
  pathname: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): { request: Request; readerCalls(): number; cancelCalls(): number; settleCancel(): void } {
  const cancel = deferred();
  let readerCalls = 0;
  let cancelCalls = 0;
  const source = new Request(`http://test${pathname}`, {
    method: "POST",
    headers,
    body: "placeholder",
    signal,
  });
  const reader = {
    read: () => new Promise<never>(() => {}),
    cancel: () => {
      cancelCalls++;
      return cancel.promise;
    },
    releaseLock: () => undefined,
  };
  return {
    request: new Proxy(source, {
      get(target, property) {
        if (property !== "body") return Reflect.get(target, property, target);
        return { getReader: () => { readerCalls++; return reader; } };
      },
    }) as Request,
    readerCalls: () => readerCalls,
    cancelCalls: () => cancelCalls,
    settleCancel: () => cancel.resolve(),
  };
}

function baseDependencies(principalId: string): CompiledModuleHttpDependencies {
  const root = mkdtempSync(join(tmpdir(), "compiler-ingress-cancel-drain-"));
  durableRoots.add(root);
  return {
    createSession: () => { throw new Error("cancel-drain test body must not construct a session"); },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "cancel-drain-test",
    compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
      root,
      ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
    }),
    authenticateCompilerRequest: () => ({
      status: "authenticated" as const,
      principal: { id: principalId, role: "operator" as const },
    }),
  };
}

describe("compiler ingress admission retains a slot through body cancel drain", () => {
  it("retains PDF prepare ingress until a deferred reader cancel settles", async () => {
    const ingress = new PdfPrepareIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1 });
    const abort = new AbortController();
    const first = cancelDeferredRequest("/api/compiler/prepare?moduleId=cancel-drain", { "Content-Type": "application/pdf" }, abort.signal);
    const deps = { ...baseDependencies("trusted-pdf"), pdfPrepareIngressAdmission: ingress };
    const pending = handleCompiledModuleHttpRequest(first.request, deps);
    const restoreWorker = __replacePdfPrepareWorkerForTest(async () => ({ status: "unavailable" }));
    try {
      await eventually(() => first.readerCalls() === 1);
      abort.abort();
      expect((await responseWithin(pending))?.status).toBe(408);
      expect(first.cancelCalls()).toBe(1);

      const competing = readerTrackedRequest(new Request("http://test/api/compiler/prepare?moduleId=competing", {
        method: "POST", headers: { "Content-Type": "application/pdf" }, body: "not-a-pdf",
      }));
      const busy = await responseWithin(handleCompiledModuleHttpRequest(competing.request, deps));
      expect(busy?.status).toBe(429);
      expect(competing.readerCalls()).toBe(0);

      first.settleCancel();
      await Bun.sleep(0);
      const reusable = readerTrackedRequest(new Request("http://test/api/compiler/prepare?moduleId=reusable", {
        method: "POST", headers: { "Content-Type": "application/pdf" }, body: "not-a-pdf",
      }));
      expect((await responseWithin(handleCompiledModuleHttpRequest(reusable.request, deps)))?.status).toBe(503);
      expect(reusable.readerCalls()).toBeGreaterThan(0);
    } finally {
      first.settleCancel();
      restoreWorker();
    }
  });

  it("retains compiler JSON ingress until a deferred reader cancel settles", async () => {
    const ingress = new CompilerJsonIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const abort = new AbortController();
    const first = cancelDeferredRequest("/api/compiler/resolve", { "Content-Type": "application/json" }, abort.signal);
    const deps = { ...baseDependencies("trusted-json"), jsonIngressAdmission: ingress };
    const pending = handleCompiledModuleHttpRequest(first.request, deps);
    try {
      await eventually(() => first.readerCalls() === 1);
      abort.abort();
      expect((await responseWithin(pending))?.status).toBe(408);
      expect(first.cancelCalls()).toBe(1);

      const competing = readerTrackedRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }));
      const busy = await responseWithin(handleCompiledModuleHttpRequest(competing.request, deps));
      expect(busy?.status).toBe(429);
      expect(competing.readerCalls()).toBe(0);

      first.settleCancel();
      await Bun.sleep(0);
      const reusable = readerTrackedRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }));
      expect((await responseWithin(handleCompiledModuleHttpRequest(reusable.request, deps)))?.status).toBe(400);
      expect(reusable.readerCalls()).toBeGreaterThan(0);
    } finally {
      first.settleCancel();
    }
  });

  it("retains compiled session creation ingress until a deferred reader cancel settles", async () => {
    const ingress = new CompiledSessionCreationIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const abort = new AbortController();
    const first = cancelDeferredRequest("/api/sessions/compiled", { "Content-Type": "application/json" }, abort.signal);
    const deps = {
      ...baseDependencies("trusted-compiled"),
      compiledSessionCreationIngressAdmission: ingress,
      compiledDurableHostCapability: Object.freeze(Object.create(null)) as object,
      resolveCompiledSessionPlayer: () => ({ status: "unassigned" as const }),
    };
    const pending = handleCompiledModuleHttpRequest(first.request, deps);
    try {
      await eventually(() => first.readerCalls() === 1);
      abort.abort();
      expect((await responseWithin(pending))?.status).toBe(408);
      expect(first.cancelCalls()).toBe(1);

      const competing = readerTrackedRequest(new Request("http://test/api/sessions/compiled", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }));
      const busy = await responseWithin(handleCompiledModuleHttpRequest(competing.request, deps));
      expect(busy?.status).toBe(429);
      expect(competing.readerCalls()).toBe(0);

      first.settleCancel();
      await Bun.sleep(0);
      const reusable = readerTrackedRequest(new Request("http://test/api/sessions/compiled", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }));
      expect((await responseWithin(handleCompiledModuleHttpRequest(reusable.request, deps)))?.status).toBe(400);
      expect(reusable.readerCalls()).toBeGreaterThan(0);
    } finally {
      first.settleCancel();
    }
  });
});
