import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { handleRequest, type ConfigViewDependencies } from "../api/server";
import type { GameSession } from "../api/game-session";
import { worldModelStatus } from "../api/world-model-status";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";

const marker = "config-secret-marker";
const environmentKeys = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_MAX_TOKENS",
  "LLM_TEMPERATURE",
  "WORLD_MODEL_PATH",
  "CTHULHU_MODEL_PATH",
  "PORT",
  "NODE_ENV",
  "SESSION_TIMEOUT_MINUTES",
  "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS",
  "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION",
  "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL",
  "ORDINARY_SESSION_CREATE_MAX_CONCURRENT",
  "ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL",
  "ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL",
  "ORDINARY_SESSION_CREATE_WINDOW_SECONDS",
] as const;

const unauthenticated: CompilerRequestAuthenticator = () => ({ status: "unauthenticated" });
const unavailable: CompilerRequestAuthenticator = () => ({ status: "unavailable" });
const malformed = (() => ({ status: "authenticated", principal: { id: "malformed", role: "made-up" } })) as unknown as CompilerRequestAuthenticator;
const throwing: CompilerRequestAuthenticator = () => { throw new Error("auth is unavailable"); };
const operator: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { id: "operator:config-test", role: "operator" } });
const keeper: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { id: "keeper:config-test", role: "keeper" } });
const player: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { id: "player:config-test", role: "player" } });

async function body(response: Response): Promise<string> {
  return await response.text();
}

async function isolatedHealthRequest(): Promise<Response> {
  const root = mkdtempSync(join(tmpdir(), "server-config-health-"));
  try {
    return await handleRequest(
      new Request("http://config-security.test/api"),
      undefined,
      undefined,
      {
        careerRoot: join(root, "careers"),
        sessionRoot: join(root, "sessions"),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { registry: new Map<string, GameSession>() },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertOpaque(value: string): void {
  expect(value).not.toContain(marker);
  expect(value).not.toContain("baseUrl");
  expect(value).not.toContain("model");
  expect(value).not.toContain("path");
  expect(value).not.toContain("sessionCount");
  const parsed = JSON.parse(value) as Record<string, unknown>;
  expect(parsed).not.toHaveProperty("llm");
  expect(parsed).not.toHaveProperty("server");
  expect(parsed).not.toHaveProperty("sessionCount");
  expect(parsed).not.toHaveProperty("worldModel");
  expect(parsed).not.toHaveProperty("cthulhuModel");
}

/**
 * The config view is an explicit server-owned dependency. It makes the
 * authorization order observable without handing the request a control path.
 */
async function request(authenticator: CompilerRequestAuthenticator): Promise<{ response: Response; observed: string[] }> {
  const observed: string[] = [];
  const registry = new Map<string, GameSession>(Array.from(
    { length: 7 },
    (_, index) => [`nonempty-registry-${index}`, {} as GameSession],
  ));
  const configView: ConfigViewDependencies = {
    loadConfig: () => {
      observed.push("loadConfig");
      return loadConfig();
    },
    worldModelStatus: () => {
      observed.push("worldModelStatus");
      // The status module captures its production defaults at import time.
      // Pass the current test environment explicitly so this remains a
      // no-load status observation while exercising the real path contract.
      return worldModelStatus(process.env.WORLD_MODEL_PATH, process.env.CTHULHU_MODEL_PATH);
    },
    sessionCount: () => {
      observed.push("sessionCount");
      return registry.size;
    },
  };
  const response = await handleRequest(
    new Request("http://config-security.test/api/config?role=operator", {
      headers: { "X-Compiler-Role": "operator", Authorization: "Bearer caller-controlled" },
    }),
    undefined,
    undefined,
    {},
    {},
    {
      isLlmEnabled: () => {
        observed.push("compiledRouteSetup");
        return false;
      },
    },
    authenticator,
    undefined,
    undefined,
    undefined,
    undefined,
    { registry },
    configView,
  );
  return { response, observed };
}

describe("GET /api/config operator boundary", () => {
  test("authenticates before every config/status observation and exposes the existing view to an operator only", async () => {
    const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      LLM_API_KEY: "sk-config-secret-marker",
      LLM_BASE_URL: `https://${marker}.invalid/v1`,
      LLM_MODEL: `${marker}-model`,
      LLM_MAX_TOKENS: "1024",
      LLM_TEMPERATURE: "0.7",
      WORLD_MODEL_PATH: `C:/outside/${marker}-world.json`,
      CTHULHU_MODEL_PATH: `C:/outside/${marker}-cthulhu.json`,
      PORT: "4317",
      NODE_ENV: "config-secret-environment",
      SESSION_TIMEOUT_MINUTES: "43",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS: "99",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION: "3",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL: "7",
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT: "12",
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL: "9",
      ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL: "5",
      ORDINARY_SESSION_CREATE_WINDOW_SECONDS: "42",
    });
    try {
      for (const [name, authenticator, status, code] of [
        ["unauthenticated", unauthenticated, 401, "AUTHENTICATION_REQUIRED"],
        ["unavailable", unavailable, 503, "AUTH_CAPABILITY_UNAVAILABLE"],
        ["malformed", malformed, 503, "AUTH_CAPABILITY_UNAVAILABLE"],
        ["throwing", throwing, 503, "AUTH_CAPABILITY_UNAVAILABLE"],
        ["keeper", keeper, 403, "CONFIG_OPERATOR_REQUIRED"],
        ["player", player, 403, "CONFIG_OPERATOR_REQUIRED"],
      ] as const) {
        const result = await request(authenticator);
        const responseBody = await body(result.response);
        expect(responseBody, name).not.toContain(marker);
        assertOpaque(responseBody);
        expect(result.response.status, name).toBe(status);
        expect(JSON.parse(responseBody), name).toMatchObject({ error: { stage: "auth", code } });
        expect(result.observed, name).toEqual([]);
      }

      const allowed = await request(operator);
      expect(allowed.response.status).toBe(200);
      expect(allowed.response.headers.get("Cache-Control")).toBe("no-store");
      expect(allowed.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(allowed.observed).toEqual(["loadConfig", "sessionCount", "worldModelStatus"]);
      expect(JSON.parse(await body(allowed.response))).toEqual({
        llm: {
          baseUrl: `https://${marker}.invalid/v1`,
          model: `${marker}-model`,
          maxTokens: 1024,
          temperature: 0.7,
          hasKey: true,
        },
        server: {
          port: 4317,
          env: "config-secret-environment",
          sessionTimeoutMinutes: 43,
          ordinarySessionWebSocketAdmission: { global: 99, perSession: 3, perPrincipal: 7 },
          ordinarySessionCreationAdmission: { globalConcurrent: 12, perPrincipalConcurrent: 9, startsPerPrincipal: 5, windowMs: 42_000 },
          compiledWorldModelBindingPolicy: { enabled: false, policyHash: null, bindingCount: 0, datasetId: null, datasetVersion: null },
        },
        sessionCount: 7,
        worldModel: { path: `C:/outside/${marker}-world.json`, exists: false, loaded: false, entryCount: 0 },
        cthulhuModel: { path: `C:/outside/${marker}-cthulhu.json`, exists: false, loaded: false },
      });
    } finally {
      for (const key of environmentKeys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // Health must not use a process-global runtime namespace. It still runs its
  // normal bootstrap/reconcile path against this test-owned storage domain, so
  // concurrent durable tests cannot make the public-health assertion fail with
  // SQLITE_BUSY.
  test("leaves the anonymous health route public and configuration-free", async () => {
    const response = await isolatedHealthRequest();
    expect(response.status).toBe(200);
    const value = await response.text();
    expect(value).toContain('"status": "ok"');
    expect(value).not.toContain("baseUrl");
    expect(value).not.toContain("worldModel");
  }, 20_000);
});
