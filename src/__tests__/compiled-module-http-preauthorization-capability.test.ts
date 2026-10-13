import { describe, expect, it } from "bun:test";
import {
  handleCompiledModuleHttpRequest,
  preauthorizeCompilerHttpRoute,
  type CompiledModuleHttpDependencies,
  type CompilerHttpRoutePreauthorization,
  type CompilerRequestAuthenticator,
} from "../api/compiled-module-http";
import type { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";

function bodyTrackedRequest(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string> = {},
  body?: string,
): { request: Request; readerCalls(): number } {
  let readerCalls = 0;
  const source = new Request(url, method === "GET" ? {} : { method, headers, body });
  return {
    request: new Proxy(source, {
      get(target, property) {
        if (property !== "body") return Reflect.get(target, property, target);
        const stream = target.body;
        if (!stream) return null;
        return new Proxy(stream, {
          get(bodyStream, bodyProperty) {
            if (bodyProperty !== "getReader") return Reflect.get(bodyStream, bodyProperty, bodyStream);
            return () => {
              readerCalls++;
              return bodyStream.getReader();
            };
          },
        });
      },
    }) as Request,
    readerCalls: () => readerCalls,
  };
}

function authenticator(calls: { value: number }): CompilerRequestAuthenticator {
  return () => {
    calls.value++;
    return { status: "authenticated", principal: { id: "operator:capability", role: "operator" } };
  };
}

function dependencies(
  authenticateCompilerRequest: CompilerRequestAuthenticator,
  catalogLoads: { value: number },
  preauthorization?: CompilerHttpRoutePreauthorization,
): CompiledModuleHttpDependencies {
  const catalog = {
    loadPrepared: () => {
      catalogLoads.value++;
      return { status: "refused", code: "CATALOG_NOT_FOUND", message: "test catalog must remain untouched" };
    },
  } as unknown as CompilerArtifactCatalog;
  return {
    createSession: () => { throw new Error("test route must not create a session"); },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "preauthorization-test",
    catalog,
    authenticateCompilerRequest,
    ...(preauthorization === undefined ? {} : { compilerHttpRoutePreauthorization: preauthorization }),
  };
}

async function capabilityFor(req: Request, authenticateCompilerRequest: CompilerRequestAuthenticator): Promise<CompilerHttpRoutePreauthorization> {
  const result = await preauthorizeCompilerHttpRoute(req, authenticateCompilerRequest);
  expect(result.kind).toBe("authorized");
  if (result.kind !== "authorized") throw new Error("test setup did not authenticate");
  return result.preauthorization;
}

describe("compiler HTTP preauthorization capabilities", () => {
  it("authenticates a direct inner-handler call exactly once when no capability was supplied", async () => {
    const calls = { value: 0 };
    const catalogLoads = { value: 0 };
    const request = bodyTrackedRequest("http://test/api/compiler/prepare", "POST", { "Content-Type": "text/plain" }, "not a pdf");
    const response = await handleCompiledModuleHttpRequest(request.request, dependencies(authenticator(calls), catalogLoads));
    expect(response?.status).toBe(415);
    expect(calls.value).toBe(1);
    expect(catalogLoads.value).toBe(0);
    expect(request.readerCalls()).toBe(0);
  });

  it("rejects a forged, replayed, cross-request, cross-method, or cross-path capability without auth, catalog, or body side effects", async () => {
    const forgedCalls = { value: 0 };
    const forgedCatalogLoads = { value: 0 };
    const forgedTarget = bodyTrackedRequest("http://test/api/compiler/resolve", "POST", { "Content-Type": "application/json" }, "{}");
    const forged = await handleCompiledModuleHttpRequest(
      forgedTarget.request,
      dependencies(authenticator(forgedCalls), forgedCatalogLoads, Object.freeze(Object.create(null)) as CompilerHttpRoutePreauthorization),
    );
    expect(forged?.status).toBe(401);
    expect(forgedCalls.value).toBe(0);
    expect(forgedCatalogLoads.value).toBe(0);
    expect(forgedTarget.readerCalls()).toBe(0);

    const replayCalls = { value: 0 };
    const replayCatalogLoads = { value: 0 };
    const replayTarget = bodyTrackedRequest("http://test/api/compiler/prepare", "POST", { "Content-Type": "text/plain" }, "ignored");
    const replayCapability = await capabilityFor(replayTarget.request, authenticator(replayCalls));
    expect((await handleCompiledModuleHttpRequest(replayTarget.request, dependencies(authenticator(replayCalls), replayCatalogLoads, replayCapability)))?.status).toBe(415);
    const replay = await handleCompiledModuleHttpRequest(replayTarget.request, dependencies(authenticator(replayCalls), replayCatalogLoads, replayCapability));
    expect(replay?.status).toBe(401);
    expect(replayCalls.value).toBe(1);
    expect(replayCatalogLoads.value).toBe(0);
    expect(replayTarget.readerCalls()).toBe(0);

    for (const [name, target] of [
      ["cross-request", bodyTrackedRequest("http://test/api/compiler/prepare", "POST", { "Content-Type": "application/pdf" }, "not a pdf")],
      ["cross-path", bodyTrackedRequest("http://test/api/compiler/resolve", "POST", { "Content-Type": "application/json" }, "{}")] as const,
    ] as const) {
      const calls = { value: 0 };
      const catalogLoads = { value: 0 };
      const origin = new Request("http://test/api/compiler/prepare", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: "origin" });
      const capability = await capabilityFor(origin, authenticator(calls));
      const response = await handleCompiledModuleHttpRequest(target.request, dependencies(authenticator(calls), catalogLoads, capability));
      expect(response?.status, name).toBe(401);
      expect(calls.value, name).toBe(1);
      expect(catalogLoads.value, name).toBe(0);
      expect(target.readerCalls(), name).toBe(0);
    }

    const methodCalls = { value: 0 };
    const methodCatalogLoads = { value: 0 };
    const methodOrigin = new Request("http://test/api/compiler/prepare", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: "origin" });
    const methodCapability = await capabilityFor(methodOrigin, authenticator(methodCalls));
    const methodTarget = new Request("http://test/api/compiler/artifacts/not-an-authorized-id");
    const methodResponse = await handleCompiledModuleHttpRequest(methodTarget, dependencies(authenticator(methodCalls), methodCatalogLoads, methodCapability));
    expect(methodResponse?.status).toBe(401);
    expect(methodCalls.value).toBe(1);
    expect(methodCatalogLoads.value).toBe(0);
  });
});
