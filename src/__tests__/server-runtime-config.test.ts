import { describe, expect, test } from "bun:test";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import {
  authorizeOrdinarySessionWebSocketUpgrade,
  createEnvironmentOrdinaryIntentPolicy,
  createEnvironmentOrdinarySessionAccessOptions,
  handleRequest,
} from "../api/server";
import { resolveServerRuntimeConfig } from "../api/server-runtime-config";

const runtimeConfigOperator: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { id: "operator:runtime-config-test", role: "operator" },
});

const RUNTIME_ENV_KEYS = [
  "PORT",
  "SESSION_TIMEOUT_MINUTES",
  "NODE_ENV",
  "ORDINARY_SESSION_AUTH_MODE",
  "ORDINARY_SESSION_INTENT_POLICY",
  "ORDINARY_SESSION_CREATE_MAX_CONCURRENT",
  "ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL",
  "ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL",
  "ORDINARY_SESSION_CREATE_WINDOW_SECONDS",
] as const;

async function withEnvironment<T>(
  entries: Partial<Record<(typeof RUNTIME_ENV_KEYS)[number], string | undefined>>,
  operation: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map(RUNTIME_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = entries[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await operation();
  } finally {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function configRequest(authenticator: CompilerRequestAuthenticator = runtimeConfigOperator): Promise<Response> {
  return handleRequest(
    new Request("http://runtime-config.test/api/config"),
    undefined,
    undefined,
    {},
    {},
    {},
    authenticator,
  );
}

describe("ordinary development escape hatches", () => {
  test("accepts the intent fallback only for exact development or test", () => {
    for (const nodeEnv of ["Production", "prod", "", undefined, "staging"] as const) {
      expect(createEnvironmentOrdinaryIntentPolicy({
        ORDINARY_SESSION_INTENT_POLICY: "development_fallback",
        ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
      }), `NODE_ENV=${String(nodeEnv)}`).toBe("required");
    }
    for (const nodeEnv of ["development", "test"] as const) {
      expect(createEnvironmentOrdinaryIntentPolicy({
        ORDINARY_SESSION_INTENT_POLICY: "development_fallback",
        NODE_ENV: nodeEnv,
      }), `NODE_ENV=${nodeEnv}`).toBe("development_fallback");
    }
  });

  test("fails closed at ordinary HTTP and WebSocket access boundaries outside development or test", async () => {
    for (const nodeEnv of ["Production", "prod", "", undefined, "staging"] as const) {
      const access = createEnvironmentOrdinarySessionAccessOptions({
        ORDINARY_SESSION_AUTH_MODE: "development_anonymous",
        ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
      });
      const http = await handleRequest(
        new Request("http://runtime-config.test/api/sessions"),
        undefined,
        undefined,
        {},
        {},
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        access,
      );
      expect(http.status, `HTTP NODE_ENV=${String(nodeEnv)}`).toBe(503);
      expect(await http.json(), `HTTP NODE_ENV=${String(nodeEnv)}`).toMatchObject({
        error: { code: "ORDINARY_SESSION_AUTH_UNAVAILABLE" },
      });

      const websocket = await authorizeOrdinarySessionWebSocketUpgrade(
        new Request("http://runtime-config.test/ws?session=legacy-ordinary&role=player&playerId=legacy"),
        { ordinarySessionAccess: access },
      );
      expect(websocket, `WS NODE_ENV=${String(nodeEnv)}`).toBeInstanceOf(Response);
      expect((websocket as Response).status, `WS NODE_ENV=${String(nodeEnv)}`).toBe(503);
    }

    for (const nodeEnv of ["development", "test"] as const) {
      const access = createEnvironmentOrdinarySessionAccessOptions({
        ORDINARY_SESSION_AUTH_MODE: "development_anonymous",
        NODE_ENV: nodeEnv,
      });
      const http = await handleRequest(
        new Request("http://runtime-config.test/api/sessions"),
        undefined,
        undefined,
        {},
        {},
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        access,
      );
      expect(http.status, `HTTP NODE_ENV=${nodeEnv}`).toBe(200);
      const websocket = await authorizeOrdinarySessionWebSocketUpgrade(
        new Request("http://runtime-config.test/ws?session=legacy-ordinary&role=player&playerId=legacy"),
        { ordinarySessionAccess: access },
      );
      expect(websocket, `WS NODE_ENV=${nodeEnv}`).toEqual({
        sessionId: "legacy-ordinary", role: "player", playerId: "legacy",
      });
    }
  }, 15_000);

  test("does not reopen anonymous access when a missing startup NODE_ENV is later mutated", async () => {
    const access = createEnvironmentOrdinarySessionAccessOptions({
      ORDINARY_SESSION_AUTH_MODE: "development_anonymous",
    });
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const websocket = await authorizeOrdinarySessionWebSocketUpgrade(
        new Request("http://runtime-config.test/ws?session=legacy-ordinary&role=player&playerId=legacy"),
        { ordinarySessionAccess: access },
      );
      expect(websocket).toBeInstanceOf(Response);
      expect((websocket as Response).status).toBe(503);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});

describe("server runtime environment parsing", () => {
  test("returns a fixed 503 instead of misreporting every invalid PORT value through a direct config request", async () => {
    for (const port of ["0", "-1", "1.5", "3099junk", " 3099", "3099 ", "", "65536", "999999999999999999999"] as const) {
      const response = await withEnvironment({ PORT: port, SESSION_TIMEOUT_MINUTES: "30" }, configRequest);
      expect(response.status, `PORT=${JSON.stringify(port)}`).toBe(503);
      expect(await response.json(), `PORT=${JSON.stringify(port)}`).toEqual({
        error: { stage: "config", code: "SERVER_RUNTIME_CONFIG_INVALID", message: "server runtime configuration is invalid" },
      });
    }
  });

  test("returns a fixed 503 instead of misreporting every invalid session timeout through a direct config request", async () => {
    for (const timeout of ["0", "-1", "1.5", "30minutes", " 30", "30 ", "", "NaN", "999999999999999999999"] as const) {
      const response = await withEnvironment({ PORT: "3099", SESSION_TIMEOUT_MINUTES: timeout }, configRequest);
      expect(response.status, `SESSION_TIMEOUT_MINUTES=${JSON.stringify(timeout)}`).toBe(503);
      expect(await response.json(), `SESSION_TIMEOUT_MINUTES=${JSON.stringify(timeout)}`).toEqual({
        error: { stage: "config", code: "SERVER_RUNTIME_CONFIG_INVALID", message: "server runtime configuration is invalid" },
      });
    }
  });

  test("authenticates before rejecting invalid direct runtime configuration", async () => {
    const response = await withEnvironment(
      { PORT: "0junk", SESSION_TIMEOUT_MINUTES: "0" },
      () => configRequest(() => ({ status: "unauthenticated" })),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { stage: "auth", code: "AUTHENTICATION_REQUIRED" } });
  });

  test("keeps documented defaults when both runtime settings are absent", async () => {
    const response = await withEnvironment({ PORT: undefined, SESSION_TIMEOUT_MINUTES: undefined }, configRequest);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      server: { port: 3099, env: "unset", sessionTimeoutMinutes: 30 },
    });
  });

  test("reports an empty or unknown NODE_ENV exactly without relabeling it as development", async () => {
    for (const nodeEnv of ["", "Production", "prod", "staging"] as const) {
      const response = await withEnvironment({
        PORT: "3099", SESSION_TIMEOUT_MINUTES: "30", NODE_ENV: nodeEnv,
      }, configRequest);
      expect(await response.json(), `NODE_ENV=${JSON.stringify(nodeEnv)}`).toMatchObject({
        server: { env: nodeEnv },
      });
    }
  });

  test("strictly parses valid values and rejects unsafe millisecond conversions", () => {
    expect(resolveServerRuntimeConfig({ PORT: "65535", SESSION_TIMEOUT_MINUTES: "1", NODE_ENV: "test" })).toEqual({
      port: 65535,
      sessionTimeoutMinutes: 1,
      sessionTimeoutMs: 60_000,
      nodeEnv: "test",
      ordinarySessionWebSocketAdmission: { global: 512, perSession: 4, perPrincipal: 32 },
      ordinarySessionCreationAdmission: { globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000 },
    });
    expect(resolveServerRuntimeConfig({})).toEqual({
      port: 3099,
      sessionTimeoutMinutes: 30,
      sessionTimeoutMs: 1_800_000,
      nodeEnv: undefined,
      ordinarySessionWebSocketAdmission: { global: 512, perSession: 4, perPrincipal: 32 },
      ordinarySessionCreationAdmission: { globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000 },
    });
    expect(() => resolveServerRuntimeConfig({
      PORT: "3099",
      SESSION_TIMEOUT_MINUTES: String(Math.floor(Number.MAX_SAFE_INTEGER / 60_000) + 1),
    })).toThrow(/SESSION_TIMEOUT_MINUTES/);
  });

  test("strictly validates ordinary creation admission limits and their safe second conversion", () => {
    expect(resolveServerRuntimeConfig({
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT: "7",
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL: "3",
      ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL: "9",
      ORDINARY_SESSION_CREATE_WINDOW_SECONDS: "61",
    }).ordinarySessionCreationAdmission).toEqual({
      globalConcurrent: 7, perPrincipalConcurrent: 3, startsPerPrincipal: 9, windowMs: 61_000,
    });
    for (const value of ["0", "-1", "1.5", "2junk", " 2", "", "999999999999999999999"] as const) {
      expect(() => resolveServerRuntimeConfig({ ORDINARY_SESSION_CREATE_MAX_CONCURRENT: value })).toThrow(/ORDINARY_SESSION_CREATE_MAX_CONCURRENT/);
    }
    expect(() => resolveServerRuntimeConfig({
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT: "1",
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL: "2",
    })).toThrow(/PER_PRINCIPAL/);
    expect(() => resolveServerRuntimeConfig({
      ORDINARY_SESSION_CREATE_WINDOW_SECONDS: String(Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1),
    })).toThrow(/WINDOW_SECONDS/);
  });
});
