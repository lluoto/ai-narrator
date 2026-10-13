import { describe, expect, test } from "bun:test";
import {
  bindShutdownSignals,
  createServerShutdownController,
  type ShutdownController,
  type ShutdownResult,
} from "../api/server-shutdown";
import { closeAllWsClients, createWsClient, removeWsClient } from "../api/ws-handler";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("server shutdown controller", () => {
  test("gates new requests, drains admitted work, then closes sockets and sessions once", async () => {
    const request = deferred<Response>();
    const closed: string[] = [];
    const sessions = new Map([
      ["one", { close: () => closed.push("one") }],
      ["two", { close: () => closed.push("two") }],
    ]);
    const stopCalls: boolean[] = [];
    let cleanupClears = 0;
    let websocketScans = 0;
    const websocketCloseCodes: number[] = [];
    const controller = createServerShutdownController({
      listener: { stop: (closeActiveConnections) => { stopCalls.push(closeActiveConnections ?? false); return Promise.resolve(); } },
      sessions,
      clearCleanupTimer: () => { cleanupClears++; },
      closeWebSockets: (code) => { websocketScans++; websocketCloseCodes.push(code); },
      graceMs: 100,
    });

    const admitted = controller.trackRequest(() => request.promise);
    const firstShutdown = controller.beginShutdown();
    expect(controller.beginShutdown()).toBe(firstShutdown);
    expect(controller.isDraining()).toBe(true);
    expect(stopCalls).toEqual([false]);
    expect(cleanupClears).toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(websocketScans).toBe(1);

    let blockedHandlerRan = false;
    const blocked = await controller.trackRequest(() => {
      blockedHandlerRan = true;
      return Promise.resolve(new Response("unexpected"));
    });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: { code: "SERVER_DRAINING" } });
    expect(blockedHandlerRan).toBe(false);
    expect(closed).toEqual([]);

    request.resolve(new Response("admitted"));
    expect((await admitted).status).toBe(200);
    expect(await firstShutdown).toEqual({ status: "drained", closedSessions: 2 });
    expect(websocketScans).toBe(2);
    expect(websocketCloseCodes).toEqual([1001, 1001]);
    expect(closed).toEqual(["one", "two"]);
    expect(sessions.size).toBe(0);
  });

  test("fails closed on grace expiry without closing sessions while work is still in flight", async () => {
    const request = deferred<Response>();
    const closed: string[] = [];
    let crashLikeTimeouts = 0;
    const sessions = new Map([["one", { close: () => closed.push("one") }]]);
    const controller = createServerShutdownController({
      listener: { stop: () => Promise.resolve() },
      sessions,
      clearCleanupTimer: () => undefined,
      closeWebSockets: () => undefined,
      graceMs: 5,
      onGraceTimeout: () => { crashLikeTimeouts++; },
    });

    const admitted = controller.trackRequest(() => request.promise);
    expect(await controller.beginShutdown()).toEqual({ status: "timed_out" });
    expect(crashLikeTimeouts).toBe(1);
    expect(closed).toEqual([]);
    expect(sessions.size).toBe(1);

    request.resolve(new Response("late"));
    await admitted;
    expect(closed).toEqual([]);
    expect(sessions.size).toBe(1);
  });

  test("closes websockets before waiting for a listener that needs websocket drain", async () => {
    const listenerStopped = deferred<void>();
    const closed: string[] = [];
    let websocketScans = 0;
    const sessions = new Map([["one", { close: () => closed.push("one") }]]);
    const controller = createServerShutdownController({
      listener: { stop: () => listenerStopped.promise },
      sessions,
      clearCleanupTimer: () => undefined,
      closeWebSockets: () => {
        websocketScans++;
        listenerStopped.resolve();
      },
      graceMs: 25,
    });

    expect(await controller.beginShutdown()).toEqual({ status: "drained", closedSessions: 1 });
    expect(websocketScans).toBe(2);
    expect(closed).toEqual(["one"]);
    expect(sessions.size).toBe(0);
  });

  test("fences websocket admission synchronously before the first websocket sweep", async () => {
    const order: string[] = [];
    const controller = createServerShutdownController({
      listener: { stop: () => { order.push("listener"); } },
      sessions: new Map(),
      clearCleanupTimer: () => { order.push("timer"); },
      beginWebSocketAdmissionDrain: () => { order.push("admission"); },
      closeWebSockets: () => { order.push("sweep"); },
    });

    expect(await controller.beginShutdown()).toEqual({ status: "drained", closedSessions: 0 });
    expect(order).toEqual(["admission", "timer", "listener", "sweep", "sweep"]);
  });

  test("fails closed when listener stop rejects or a websocket sweep throws", async () => {
    const rejectedClosed: string[] = [];
    const rejectedSessions = new Map([["one", { close: () => rejectedClosed.push("one") }]]);
    const listenerRejected = createServerShutdownController({
      listener: { stop: () => Promise.reject(new Error("listener refused")) },
      sessions: rejectedSessions,
      clearCleanupTimer: () => undefined,
      closeWebSockets: () => undefined,
    });
    expect(await listenerRejected.beginShutdown()).toEqual({ status: "listener_failed" });
    expect(rejectedClosed).toEqual([]);
    expect(rejectedSessions.size).toBe(1);

    const websocketClosed: string[] = [];
    const websocketSessions = new Map([["one", { close: () => websocketClosed.push("one") }]]);
    const websocketFailed = createServerShutdownController({
      listener: { stop: () => Promise.resolve() },
      sessions: websocketSessions,
      clearCleanupTimer: () => undefined,
      closeWebSockets: () => { throw new Error("websocket sweep failed"); },
    });
    expect(await websocketFailed.beginShutdown()).toEqual({ status: "websocket_close_failed" });
    expect(websocketClosed).toEqual([]);
    expect(websocketSessions.size).toBe(1);
  });

  test("consumes listener rejection when the first websocket sweep also fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    const closed: string[] = [];
    const sessions = new Map([["one", { close: () => closed.push("one") }]]);
    try {
      const controller = createServerShutdownController({
        listener: { stop: () => Promise.reject(new Error("listener rejected before websocket failure")) },
        sessions,
        clearCleanupTimer: () => undefined,
        closeWebSockets: () => { throw new Error("websocket sweep failed first"); },
      });

      expect(await controller.beginShutdown()).toEqual({ status: "websocket_close_failed" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(closed).toEqual([]);
      expect(sessions.size).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

test("shutdown websocket sweep uses the explicit going-away close code", () => {
  const closed: Array<{ code: number; reason: string }> = [];
  const ws = {
    close(code: number, reason: string) {
      closed.push({ code, reason });
    },
  } as unknown as Parameters<typeof createWsClient>[0];
  createWsClient(ws, "shutdown-test");
  try {
    closeAllWsClients();
    expect(closed).toEqual([{ code: 1001, reason: "Server shutting down" }]);
  } finally {
    removeWsClient(ws);
  }
});

test("shutdown websocket sweep attempts every client before reporting close failures", () => {
  const firstFailure = new Error("first websocket close failed");
  const attempted: Array<{ code: number; reason: string }> = [];
  const failingSocket = {
    close() { throw firstFailure; },
  } as unknown as Parameters<typeof createWsClient>[0];
  const laterSocket = {
    close(code: number, reason: string) { attempted.push({ code, reason }); },
  } as unknown as Parameters<typeof createWsClient>[0];
  createWsClient(failingSocket, "shutdown-failing-client");
  createWsClient(laterSocket, "shutdown-later-client");
  try {
    let thrown: unknown;
    try {
      closeAllWsClients();
    } catch (error) {
      thrown = error;
    }
    expect(attempted).toEqual([{ code: 1001, reason: "Server shutting down" }]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([firstFailure]);
  } finally {
    removeWsClient(failingSocket);
    removeWsClient(laterSocket);
  }
});

test("controller fails closed when the real websocket registry reports a close failure", async () => {
  const websocketFailure = new Error("registered websocket close failed");
  const failingSocket = {
    close() { throw websocketFailure; },
  } as unknown as Parameters<typeof createWsClient>[0];
  const closed: string[] = [];
  const sessions = new Map([["one", { close: () => closed.push("one") }]]);
  createWsClient(failingSocket, "shutdown-controller-failure");
  try {
    const controller = createServerShutdownController({
      listener: { stop: () => Promise.resolve() },
      sessions,
      clearCleanupTimer: () => undefined,
      closeWebSockets: closeAllWsClients,
    });
    expect(await controller.beginShutdown()).toEqual({ status: "websocket_close_failed" });
    expect(closed).toEqual([]);
    expect(sessions.size).toBe(1);
  } finally {
    removeWsClient(failingSocket);
  }
});

test("signal binding invokes one shared shutdown and exits only for a crash-like timeout", async () => {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  let starts = 0;
  const drained: ShutdownResult = { status: "drained", closedSessions: 0 };
  const controller: ShutdownController = {
    isDraining: () => false,
    trackRequest: async <T>(request: () => T | Promise<T>) => request(),
    beginShutdown: () => { starts++; return Promise.resolve(drained); },
  };
  bindShutdownSignals(controller, {
    once: (signal, handler) => { handlers.set(signal, handler); },
    exit: (code) => { exits.push(code); },
  });

  handlers.get("SIGTERM")!();
  handlers.get("SIGINT")!();
  await Promise.resolve();
  expect(starts).toBe(1);
  expect(exits).toEqual([]);

  const timeoutHandlers = new Map<string, () => void>();
  bindShutdownSignals(
    {
      ...controller,
      beginShutdown: () => Promise.resolve({ status: "timed_out" }),
    },
    {
      once: (signal, handler) => { timeoutHandlers.set(signal, handler); },
      exit: (code) => { exits.push(code); },
    },
  );
  timeoutHandlers.get("SIGTERM")!();
  await Promise.resolve();
  expect(exits).toEqual([1]);
});
