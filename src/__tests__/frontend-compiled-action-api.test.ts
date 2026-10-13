import { afterEach, describe, expect, it } from "bun:test";
// @ts-expect-error The browser client is JavaScript and deliberately has no declaration file.
import { compiledSessionGeneration, getCompiledActions, sendSessionAction } from "../../frontend/src/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("compiled-session frontend API client", () => {
  it("recognizes generation zero and classifies before its idempotent structured commit", async () => {
    expect(compiledSessionGeneration({ generation: 0 })).toBe(0);
    expect(compiledSessionGeneration({ summary: { generation: 3 } })).toBe(3);
    expect(compiledSessionGeneration({ generation: -1 })).toBeNull();

    const calls: Array<{ url: string; body: unknown }> = [];
    const responses = [
      { status: "selected", mechanismId: "search_desk", generation: 0 },
      { generation: 1, narrative: "已执行。", state: { round: 1 } },
    ];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(sendSessionAction("compiled-1", "仔细搜查书桌", {
      compiledGeneration: 0,
      pcId: "p1",
      actionId: "018f14a2-c2be-7b73-b291-6e64eaf7868f",
    })).resolves.toEqual({
      kind: "executed",
      resolution: { status: "selected", mechanismId: "search_desk", generation: 0 },
      data: { generation: 1, narrative: "已执行。", state: { round: 1 } },
    });
    expect(calls).toEqual([
      {
        url: "/api/sessions/compiled-1/compiled/intents",
        body: { input: "仔细搜查书桌", pcId: "p1", expectedGeneration: 0 },
      },
      {
        url: "/api/sessions/compiled-1/compiled/actions",
        body: { mechanismId: "search_desk", pcId: "p1", actionId: "018f14a2-c2be-7b73-b291-6e64eaf7868f", expectedGeneration: 0 },
      },
    ]);
  });

  it("does not execute when the model returns ambiguity, no match, or unavailable", async () => {
    for (const resolution of [
      { status: "ambiguous", mechanismIds: ["search_desk", "leave_room"], generation: 2 },
      { status: "no_match", generation: 2 },
    ]) {
      const calls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify(resolution), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      await expect(sendSessionAction("compiled-2", "随便做点什么", {
        compiledGeneration: 2,
        pcId: "p1",
        actionId: "018f14a2-c2be-7b73-b291-6e64eaf78690",
      })).resolves.toEqual({ kind: "unresolved", resolution });
      expect(calls).toEqual(["/api/sessions/compiled-2/compiled/intents"]);
    }

    const unavailableCalls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      unavailableCalls.push(String(url));
      return new Response(JSON.stringify({ code: "compiled_intent_model_unavailable", generation: 2 }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    await expect(sendSessionAction("compiled-2", "随便做点什么", {
      compiledGeneration: 2,
      pcId: "p1",
      actionId: "018f14a2-c2be-7b73-b291-6e64eaf78690",
    })).rejects.toThrow("compiled_intent_model_unavailable");
    expect(unavailableCalls).toEqual(["/api/sessions/compiled-2/compiled/intents"]);
  });

  it("reads the compiled catalog from its structured discovery endpoint", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("/api/sessions/compiled-3/compiled/actions?pcId=p1");
      return new Response(JSON.stringify({ generation: 0, actions: [{ mechanismId: "search_desk", label: "Search the desk" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    await expect(getCompiledActions("compiled-3")).resolves.toEqual({
      generation: 0,
      actions: [{ mechanismId: "search_desk", label: "Search the desk" }],
    });
  });

  it("retains the single text endpoint for ordinary sessions", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ narrative: "普通行动", state: { round: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(sendSessionAction("ordinary-1", "看看四周", { compiledGeneration: null })).resolves.toEqual({
      kind: "ordinary",
      data: { narrative: "普通行动", state: { round: 1 } },
    });
    expect(calls).toEqual([{
      url: "/api/sessions/ordinary-1/action",
      body: { input: "看看四周" },
    }]);
  });
});
