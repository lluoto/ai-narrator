/**
 * Process-local shutdown coordination for the Bun HTTP host.  This makes no
 * durability claim: a grace timeout is handled as crash-like so admitted work
 * and live sessions are left intact for the runtime's usual recovery path.
 */
export type ShutdownResult =
  | { status: "drained"; closedSessions: number }
  | { status: "timed_out" }
  | { status: "listener_failed" }
  | { status: "websocket_close_failed" };

export interface ShutdownListener {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface ShutdownSession {
  close(): void;
}

export interface ShutdownController {
  isDraining(): boolean;
  trackRequest<T>(request: () => T | Promise<T>): Promise<T | Response>;
  beginShutdown(): Promise<ShutdownResult>;
}

export interface ServerShutdownOptions {
  listener: ShutdownListener;
  sessions: Map<string, ShutdownSession>;
  clearCleanupTimer: () => void;
  /** Must synchronously fence upgrades before the first websocket sweep. */
  beginWebSocketAdmissionDrain?: () => void;
  closeWebSockets: (code: number, reason: string) => void;
  graceMs?: number;
  onGraceTimeout?: () => void;
  onSessionCloseError?: (error: unknown) => void;
}

export interface ShutdownSignalRuntime {
  once(signal: "SIGTERM" | "SIGINT", handler: () => void): unknown;
  exit(code: number): void;
}

export const DEFAULT_SERVER_SHUTDOWN_GRACE_MS = 10_000;

function drainingResponse(): Response {
  return Response.json(
    { error: { code: "SERVER_DRAINING" } },
    { status: 503, headers: { "Retry-After": "1" } },
  );
}

export function createServerShutdownController(options: ServerShutdownOptions): ShutdownController {
  let draining = false;
  let shutdownPromise: Promise<ShutdownResult> | undefined;
  let inFlight = 0;
  const drainWaiters = new Set<() => void>();

  function notifyWhenDrained(): void {
    if (inFlight !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }

  function waitForDrained(): Promise<void> {
    if (inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.add(resolve));
  }

  async function shutdown(): Promise<ShutdownResult> {
    const graceMs = Math.max(0, Math.floor(options.graceMs ?? DEFAULT_SERVER_SHUTDOWN_GRACE_MS));
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timed_out">((resolve) => {
      timeoutId = setTimeout(() => {
        resolve("timed_out");
      }, graceMs);
    });
    const timeoutResult = (): ShutdownResult => {
      options.onGraceTimeout?.();
      return { status: "timed_out" };
    };

    try {
      let listenerStop: Promise<"stopped" | "listener_failed">;
      try {
        listenerStop = Promise.resolve(options.listener.stop(false)).then(
          () => "stopped" as const,
          () => "listener_failed" as const,
        );
      } catch {
        listenerStop = Promise.resolve("listener_failed");
      }
      try {
        options.closeWebSockets(1001, "Server shutting down");
      } catch {
        return { status: "websocket_close_failed" };
      }

      const drainCompletion = waitForDrained().then(() => "drained" as const);
      const completion = await Promise.race([
        listenerStop.then((outcome) => outcome === "listener_failed" ? outcome : drainCompletion),
        timeout,
      ]);
      if (completion === "timed_out") return timeoutResult();
      if (completion === "listener_failed") return { status: "listener_failed" };

      // An upgrade admitted immediately before draining can appear after the
      // first scan, so close the registry once more after request drain.
      try {
        options.closeWebSockets(1001, "Server shutting down");
      } catch {
        return { status: "websocket_close_failed" };
      }
      const liveSessions = [...new Set(options.sessions.values())];
      options.sessions.clear();
      for (const session of liveSessions) {
        try {
          session.close();
        } catch (error) {
          options.onSessionCloseError?.(error);
        }
      }
      return { status: "drained", closedSessions: liveSessions.length };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  return {
    isDraining: () => draining,
    trackRequest<T>(request: () => T | Promise<T>): Promise<T | Response> {
      if (draining) return Promise.resolve(drainingResponse());
      inFlight++;
      return Promise.resolve()
        .then(request)
        .finally(() => {
          inFlight--;
          notifyWhenDrained();
        });
    },
    beginShutdown(): Promise<ShutdownResult> {
      if (shutdownPromise) return shutdownPromise;
      draining = true;
      options.beginWebSocketAdmissionDrain?.();
      options.clearCleanupTimer();
      shutdownPromise = shutdown();
      return shutdownPromise;
    },
  };
}

export function bindShutdownSignals(
  controller: ShutdownController,
  runtime: ShutdownSignalRuntime = {
    once: (signal, handler) => process.once(signal, handler),
    exit: (code) => process.exit(code),
  },
): void {
  let receivedSignal = false;
  const begin = (): void => {
    if (receivedSignal) return;
    receivedSignal = true;
    void controller.beginShutdown().then(
      (result) => {
        if (result.status !== "drained") runtime.exit(1);
      },
      () => runtime.exit(1),
    );
  };
  runtime.once("SIGTERM", begin);
  runtime.once("SIGINT", begin);
}
