import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveServerRuntimeConfig } from "../api/server-runtime-config";
import { admitOrdinarySessionWebSocketUpgrade, ordinaryWebSocketPrincipalKey } from "../api/server";
import {
  bindOrdinarySessionWebSocketAdmission,
  OrdinarySessionWebSocketAdmissionController,
  type OrdinarySessionWebSocketAdmissionLease,
  type OrdinarySessionWebSocketAdmissionLimits,
} from "../api/ordinary-session-websocket-admission";
import {
  closeAdmittedOrdinarySessionWebSocket,
  openAdmittedOrdinarySessionWebSocket,
  wsStats,
} from "../api/ws-handler";

const limits: OrdinarySessionWebSocketAdmissionLimits = {
  global: 3,
  perSession: 1,
  perPrincipal: 2,
};

const controllers: OrdinarySessionWebSocketAdmissionController[] = [];

function controller(
  configuredLimits: OrdinarySessionWebSocketAdmissionLimits = limits,
  handshakeTimeoutMs = 1_000,
): OrdinarySessionWebSocketAdmissionController {
  const admission = new OrdinarySessionWebSocketAdmissionController(configuredLimits, {
    handshakeTimeoutMs,
  });
  controllers.push(admission);
  return admission;
}

function reserve(
  admission: OrdinarySessionWebSocketAdmissionController,
  sessionId: string,
  principalKey: string,
): OrdinarySessionWebSocketAdmissionLease {
  const result = admission.reserve({ sessionId, principalKey });
  expect(result.status).toBe("reserved");
  if (result.status !== "reserved") {
    throw new Error("Expected a websocket admission reservation");
  }
  return result.lease;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  for (const admission of controllers.splice(0)) {
    admission.beginDraining();
  }
});

describe("ordinary websocket admission runtime configuration", () => {
  test("strictly parses all limits and rejects invalid values or impossible relationships", () => {
    const config = resolveServerRuntimeConfig({
      PORT: "3099",
      SESSION_TIMEOUT_MINUTES: "30",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS: "9",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION: "4",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL: "7",
    });

    expect(config.ordinarySessionWebSocketAdmission).toEqual({
      global: 9,
      perSession: 4,
      perPrincipal: 7,
    });

    for (const value of ["0", "-1", "1.5", "1x", " 1", "", "9007199254740992"]) {
      expect(() =>
        resolveServerRuntimeConfig({
          ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS: value,
        }),
      ).toThrow("Invalid ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS");
    }

    expect(() =>
      resolveServerRuntimeConfig({
        ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS: "3",
        ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION: "4",
      }),
    ).toThrow("must not exceed ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS");
    expect(() =>
      resolveServerRuntimeConfig({
        ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS: "3",
        ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL: "4",
      }),
    ).toThrow("must not exceed ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS");
  });
});

describe("ordinary websocket admission controller", () => {
  test("derives isolated capacity buckets from the authenticated role and id, never request-selected labels", () => {
    const operatorAlice = ordinaryWebSocketPrincipalKey({ role: "operator", id: "alice" });
    const keeperAlice = ordinaryWebSocketPrincipalKey({ role: "keeper", id: "alice" });
    const operatorBob = ordinaryWebSocketPrincipalKey({ role: "operator", id: "bob" });
    expect(operatorAlice).toBe(JSON.stringify(["operator", "alice"]));
    expect(operatorAlice).not.toBe(keeperAlice);
    expect(operatorAlice).not.toBe(operatorBob);

    const admission = controller({ global: 3, perSession: 1, perPrincipal: 1 });
    reserve(admission, "session-a", operatorAlice);
    expect(admission.reserve({ sessionId: "session-b", principalKey: operatorAlice }).status).toBe("capacity-exceeded");
    expect(admission.reserve({ sessionId: "session-b", principalKey: operatorBob }).status).toBe("reserved");
  });

  test("upgrade seam turns the second completed authorization into opaque capacity refusal", async () => {
    const upgradeCalls: string[] = [];
    const admission = controller({ global: 1, perSession: 1, perPrincipal: 1 });
    const authorization = async () => ({
      data: { sessionId: "session-a", role: "kp" as const },
      admissionBinding: { sessionId: "session-a", principalKey: "host:alice" },
    });
    const server = {
      upgrade(_req: Request) {
        upgradeCalls.push("session-a");
        return true;
      },
    };

    const [first, second] = await Promise.all([
      admitOrdinarySessionWebSocketUpgrade(new Request("http://localhost/ws"), server, { admission, authorization }),
      admitOrdinarySessionWebSocketUpgrade(new Request("http://localhost/ws"), server, { admission, authorization }),
    ]);
    expect(first).toBeUndefined();
    expect(second?.status).toBe(429);
    expect(await second?.json()).toEqual({ error: { code: "WEBSOCKET_CAPACITY_EXCEEDED" } });
    expect(second?.headers.get("Retry-After")).toBe("1");
    expect(upgradeCalls).toEqual(["session-a"]);
  });

  test("foreign authorization consumes no capacity, and rejected upgrade attempts release it", async () => {
    const admission = controller({ global: 1, perSession: 1, perPrincipal: 1 });
    const server = { upgrade: () => false };
    const foreign = await admitOrdinarySessionWebSocketUpgrade(new Request("http://localhost/ws"), server, {
      admission,
      authorization: async () => new Response("ordinary session was not found", { status: 404 }),
    });
    expect(foreign?.status).toBe(404);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });

    const refused = await admitOrdinarySessionWebSocketUpgrade(new Request("http://localhost/ws"), server, {
      admission,
      authorization: async () => ({
        data: { sessionId: "session-a", role: "kp" as const },
        admissionBinding: { sessionId: "session-a", principalKey: "host:alice" },
      }),
    });
    expect(refused?.status).toBe(400);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });

    const throwing = await admitOrdinarySessionWebSocketUpgrade(new Request("http://localhost/ws"), {
      upgrade: () => { throw new Error("upgrade failure"); },
    }, {
      admission,
      authorization: async () => ({
        data: { sessionId: "session-a", role: "kp" as const },
        admissionBinding: { sessionId: "session-a", principalKey: "host:alice" },
      }),
    });
    expect(throwing?.status).toBe(400);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });
  });

  test("an upgrade paused in authorization is refused after the synchronous shutdown drain fence", async () => {
    const admission = controller({ global: 1, perSession: 1, perPrincipal: 1 });
    const authorization = deferred<{ data: { sessionId: string; role: "kp" }; admissionBinding: { sessionId: string; principalKey: string } }>();
    let upgrades = 0;
    const pending = admitOrdinarySessionWebSocketUpgrade(new Request("http://localhost/ws"), {
      upgrade: () => { upgrades += 1; return true; },
    }, { admission, authorization: () => authorization.promise });

    admission.beginDraining();
    authorization.resolve({
      data: { sessionId: "session-a", role: "kp" },
      admissionBinding: { sessionId: "session-a", principalKey: "host:alice" },
    });
    const response = await pending;
    expect(response?.status).toBe(503);
    expect(upgrades).toBe(0);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });
  });

  test("the production main routes every ordinary websocket upgrade through the lease-aware seam", () => {
    const main = readFileSync(resolve(import.meta.dir, "..", "api", "server.ts"), "utf8");
    expect(main).toContain("return admitOrdinarySessionWebSocketUpgrade(req, server");
    expect(main).toContain("openAdmittedOrdinarySessionWebSocket(ws, serverOrdinaryWebSocketAdmission)");
    expect(main).toContain("beginWebSocketAdmissionDrain: () => serverOrdinaryWebSocketAdmission.beginDraining()");
    expect(main).not.toContain("createWsClient(ws, sessionId, role, playerId)");
  });

  test("open path consumes only its bound lease, closes bad/late opens with 1013, and close is idempotent", async () => {
    const admission = controller({ global: 2, perSession: 2, perPrincipal: 2 }, 5);
    const data = { sessionId: "session-a", role: "kp" as const };
    const lease = reserve(admission, "session-a", "host:alice");
    bindOrdinarySessionWebSocketAdmission(data, { lease, binding: { sessionId: "session-a", principalKey: "host:alice" } });
    const closed: Array<{ code: number; reason: string }> = [];
    const ws = { data, close: (code: number, reason: string) => closed.push({ code, reason }) } as never;
    const before = wsStats().total;
    expect(openAdmittedOrdinarySessionWebSocket(ws, admission)).toBe(true);
    expect(wsStats().total).toBe(before + 1);
    closeAdmittedOrdinarySessionWebSocket(ws, admission);
    closeAdmittedOrdinarySessionWebSocket(ws, admission);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });
    expect(wsStats().total).toBe(before);

    const lateData = { sessionId: "session-b", role: "kp" as const };
    const lateLease = reserve(admission, "session-b", "host:bob");
    bindOrdinarySessionWebSocketAdmission(lateData, { lease: lateLease, binding: { sessionId: "session-b", principalKey: "host:bob" } });
    await Bun.sleep(20);
    const lateClosed: number[] = [];
    const lateWs = { data: lateData, close: (code: number) => lateClosed.push(code) } as never;
    expect(openAdmittedOrdinarySessionWebSocket(lateWs, admission)).toBe(false);
    expect(lateClosed).toEqual([1013]);
    expect(wsStats().total).toBe(before);
  });

  test("replaying an already-open lease cannot release the live socket's capacity", () => {
    const admission = controller({ global: 1, perSession: 1, perPrincipal: 1 });
    const data = { sessionId: "session-a", role: "kp" as const };
    const lease = reserve(admission, "session-a", "host:alice");
    bindOrdinarySessionWebSocketAdmission(data, { lease, binding: { sessionId: "session-a", principalKey: "host:alice" } });
    const before = wsStats().total;
    const live = { data, close: () => undefined } as never;
    expect(openAdmittedOrdinarySessionWebSocket(live, admission)).toBe(true);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 1, total: 1 });
    expect(wsStats().total).toBe(before + 1);

    const replayClosed: number[] = [];
    const replay = { data, close: (code: number) => replayClosed.push(code) } as never;
    expect(openAdmittedOrdinarySessionWebSocket(replay, admission)).toBe(false);
    expect(replayClosed).toEqual([1013]);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 1, total: 1 });
    expect(wsStats().total).toBe(before + 1);
    // Bun invokes close after the 1013 close request; that failed/replay
    // socket must not own the lease held by the live socket.
    closeAdmittedOrdinarySessionWebSocket(replay, admission);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 1, total: 1 });
    expect(wsStats().total).toBe(before + 1);

    closeAdmittedOrdinarySessionWebSocket(live, admission);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });
    expect(wsStats().total).toBe(before);
  });

  test("counts reservations as capacity before open and releases them exactly once", () => {
    const admission = controller({ global: 1, perSession: 1, perPrincipal: 1 });
    const lease = reserve(admission, "session-a", "host:alice");

    expect(admission.reserve({ sessionId: "session-a", principalKey: "host:alice" }).status).toBe(
      "capacity-exceeded",
    );
    expect(admission.releaseLease(lease)).toBe(true);
    expect(admission.releaseLease(lease)).toBe(false);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });
    expect(admission.reserve({ sessionId: "session-a", principalKey: "host:alice" }).status).toBe(
      "reserved",
    );
  });

  test("enforces per-session, authenticated-principal-across-sessions, and global buckets", () => {
    const admission = controller({ global: 3, perSession: 1, perPrincipal: 2 });
    const first = reserve(admission, "session-a", "host:alice");

    expect(admission.reserve({ sessionId: "session-a", principalKey: "host:bob" }).status).toBe(
      "capacity-exceeded",
    );
    const second = reserve(admission, "session-b", "host:alice");
    expect(admission.reserve({ sessionId: "session-c", principalKey: "host:alice" }).status).toBe(
      "capacity-exceeded",
    );
    const third = reserve(admission, "session-c", "host:bob");
    expect(admission.reserve({ sessionId: "session-d", principalKey: "host:carol" }).status).toBe(
      "capacity-exceeded",
    );

    expect(admission.activateReservedLease(first, { sessionId: "session-a", principalKey: "host:alice" })).toBe(true);
    expect(admission.activateReservedLease(second, { sessionId: "session-b", principalKey: "host:alice" })).toBe(true);
    expect(admission.activateReservedLease(third, { sessionId: "session-c", principalKey: "host:bob" })).toBe(true);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 3, total: 3 });
  });

  test("rejects forged, mismatched, expired, and replayed leases without underflow", async () => {
    const admission = controller({ global: 2, perSession: 2, perPrincipal: 2 }, 5);
    const lease = reserve(admission, "session-a", "host:alice");

    expect(admission.activateReservedLease({} as OrdinarySessionWebSocketAdmissionLease, {
      sessionId: "session-a",
      principalKey: "host:alice",
    })).toBe(false);
    expect(admission.activateReservedLease(lease, { sessionId: "session-b", principalKey: "host:alice" })).toBe(false);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });

    await Bun.sleep(20);
    expect(admission.activateReservedLease(lease, { sessionId: "session-a", principalKey: "host:alice" })).toBe(false);
    expect(admission.releaseLease(lease)).toBe(false);
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });
  });

  test("rejects invalid controller construction even outside startup parsing", () => {
    expect(() => controller({ global: 0, perSession: 1, perPrincipal: 1 })).toThrow("positive safe integers");
    expect(() => controller({ global: 2, perSession: 3, perPrincipal: 1 })).toThrow("not exceeding the global");
  });

  test("draining fences an authorization that completes after shutdown has begun", () => {
    const admission = controller();
    admission.beginDraining();

    expect(admission.reserve({ sessionId: "session-a", principalKey: "host:alice" }).status).toBe(
      "draining",
    );
    expect(admission.snapshot()).toEqual({ reserved: 0, open: 0, total: 0 });
  });
});
