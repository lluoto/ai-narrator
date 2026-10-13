/**
 * The process runtime settings have one strict parser.  Keep scalar parsing
 * here too so the liveness probe cannot accidentally accept a broader PORT
 * grammar than the server listener.
 */
export interface ServerRuntimeEnvironment {
  PORT?: string;
  SESSION_TIMEOUT_MINUTES?: string;
  NODE_ENV?: string;
  ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS?: string;
  ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION?: string;
  ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL?: string;
  ORDINARY_SESSION_CREATE_MAX_CONCURRENT?: string;
  ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL?: string;
  ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL?: string;
  ORDINARY_SESSION_CREATE_WINDOW_SECONDS?: string;
}

export interface ServerRuntimeConfig {
  readonly port: number;
  readonly sessionTimeoutMinutes: number;
  readonly sessionTimeoutMs: number;
  /** Preserved exactly: only development and test unlock development switches. */
  readonly nodeEnv: string | undefined;
  readonly ordinarySessionWebSocketAdmission: {
    readonly global: number;
    readonly perSession: number;
    readonly perPrincipal: number;
  };
  readonly ordinarySessionCreationAdmission: {
    readonly globalConcurrent: number;
    readonly perPrincipalConcurrent: number;
    readonly startsPerPrincipal: number;
    readonly windowMs: number;
  };
}

const DECIMAL_POSITIVE_INTEGER = /^[1-9]\d*$/;
const DEFAULT_PORT = "3099";
const DEFAULT_SESSION_TIMEOUT_MINUTES = "30";
const DEFAULT_ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS = "512";
const DEFAULT_ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION = "4";
const DEFAULT_ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL = "32";
const DEFAULT_ORDINARY_SESSION_CREATE_MAX_CONCURRENT = "2";
const DEFAULT_ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL = "1";
const DEFAULT_ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL = "4";
const DEFAULT_ORDINARY_SESSION_CREATE_WINDOW_SECONDS = "60";
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_SECOND = 1_000;

function parsePositiveSafeDecimal(value: string | undefined, fallback: string): number | undefined {
  const raw = value ?? fallback;
  if (!DECIMAL_POSITIVE_INTEGER.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Returns undefined for malformed/out-of-range values; absent PORT is 3099. */
export function parseServerPort(value: string | undefined): number | undefined {
  const port = parsePositiveSafeDecimal(value, DEFAULT_PORT);
  return port !== undefined && port <= 65_535 ? port : undefined;
}

/** Returns undefined for malformed/unsafe values; absent timeout is 30 minutes. */
export function parseSessionTimeoutMinutes(value: string | undefined): number | undefined {
  const minutes = parsePositiveSafeDecimal(value, DEFAULT_SESSION_TIMEOUT_MINUTES);
  if (minutes === undefined) return undefined;
  return minutes <= Math.floor(Number.MAX_SAFE_INTEGER / MILLISECONDS_PER_MINUTE)
    ? minutes
    : undefined;
}

export function parseOrdinarySessionWebSocketLimit(
  value: string | undefined,
  fallback: "global" | "perSession" | "perPrincipal",
): number | undefined {
  const defaults = {
    global: DEFAULT_ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS,
    perSession: DEFAULT_ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION,
    perPrincipal: DEFAULT_ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL,
  } as const;
  return parsePositiveSafeDecimal(value, defaults[fallback]);
}

function parseOrdinarySessionCreationLimit(value: string | undefined, fallback: string): number | undefined {
  return parsePositiveSafeDecimal(value, fallback);
}

/** Fail fast with stable messages that never reflect a deployment-provided value. */
export function resolveServerRuntimeConfig(
  env: ServerRuntimeEnvironment = process.env as ServerRuntimeEnvironment,
): ServerRuntimeConfig {
  const port = parseServerPort(env.PORT);
  if (port === undefined) throw new Error("PORT must be a decimal integer from 1 through 65535");

  const sessionTimeoutMinutes = parseSessionTimeoutMinutes(env.SESSION_TIMEOUT_MINUTES);
  if (sessionTimeoutMinutes === undefined) {
    throw new Error("SESSION_TIMEOUT_MINUTES must be a positive decimal safe integer with a safe millisecond conversion");
  }
  const global = parseOrdinarySessionWebSocketLimit(env.ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS, "global");
  if (global === undefined) {
    throw new Error("Invalid ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS");
  }
  const perSession = parseOrdinarySessionWebSocketLimit(
    env.ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION,
    "perSession",
  );
  if (perSession === undefined) {
    throw new Error("Invalid ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION");
  }
  const perPrincipal = parseOrdinarySessionWebSocketLimit(
    env.ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL,
    "perPrincipal",
  );
  if (perPrincipal === undefined) {
    throw new Error("Invalid ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL");
  }
  if (perSession > global) {
    throw new Error("ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION must not exceed ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS");
  }
  if (perPrincipal > global) {
    throw new Error("ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL must not exceed ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS");
  }

  const creationGlobal = parseOrdinarySessionCreationLimit(
    env.ORDINARY_SESSION_CREATE_MAX_CONCURRENT,
    DEFAULT_ORDINARY_SESSION_CREATE_MAX_CONCURRENT,
  );
  if (creationGlobal === undefined) throw new Error("Invalid ORDINARY_SESSION_CREATE_MAX_CONCURRENT");
  const creationPerPrincipal = parseOrdinarySessionCreationLimit(
    env.ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL,
    DEFAULT_ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL,
  );
  if (creationPerPrincipal === undefined) throw new Error("Invalid ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL");
  if (creationPerPrincipal > creationGlobal) {
    throw new Error("ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL must not exceed ORDINARY_SESSION_CREATE_MAX_CONCURRENT");
  }
  const creationStarts = parseOrdinarySessionCreationLimit(
    env.ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL,
    DEFAULT_ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL,
  );
  if (creationStarts === undefined) throw new Error("Invalid ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL");
  const creationWindowSeconds = parseOrdinarySessionCreationLimit(
    env.ORDINARY_SESSION_CREATE_WINDOW_SECONDS,
    DEFAULT_ORDINARY_SESSION_CREATE_WINDOW_SECONDS,
  );
  if (creationWindowSeconds === undefined || creationWindowSeconds > Math.floor(Number.MAX_SAFE_INTEGER / MILLISECONDS_PER_SECOND)) {
    throw new Error("ORDINARY_SESSION_CREATE_WINDOW_SECONDS must have a safe millisecond conversion");
  }

  return Object.freeze({
    port,
    sessionTimeoutMinutes,
    sessionTimeoutMs: sessionTimeoutMinutes * MILLISECONDS_PER_MINUTE,
    nodeEnv: env.NODE_ENV,
    ordinarySessionWebSocketAdmission: Object.freeze({ global, perSession, perPrincipal }),
    ordinarySessionCreationAdmission: Object.freeze({
      globalConcurrent: creationGlobal,
      perPrincipalConcurrent: creationPerPrincipal,
      startsPerPrincipal: creationStarts,
      windowMs: creationWindowSeconds * MILLISECONDS_PER_SECOND,
    }),
  });
}

export function isDevelopmentOrTestEnvironment(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}
