import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { OrdinaryActionAdmissionCoordinator } from "../api/ordinary-action-admission";
import { createWsClient, removeWsClient } from "../api/ws-handler";

const CONFIG = {
  apiKey: "sk-ordinary-action-admission-child",
  baseUrl: "http://ordinary-action-admission-child.invalid/v1",
  model: "ordinary-action-admission-child-model",
  maxTokens: 32,
  temperature: 0,
};
const FIRST = { input: "fresh process held action", actionId: "ordinary-process-admission-action-0001", expectedGeneration: 0 };
const DIFFERENT = { input: "fresh process competing action", actionId: "ordinary-process-admission-action-0002", expectedGeneration: 0 };
const authenticator: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "keeper:ordinary-action-admission" } });

function completion(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "help" }) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function runtime(root: string): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  const create: NonNullable<SessionRuntimeDependencies["createOrdinarySession"]> = ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
    const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
    session.getOpeningScene = async () => "offline opening";
    return session;
  };
  return {
    registry,
    dependencies: {
      registry,
      ordinaryIntentPolicy: "required",
      ordinarySnapshots: new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") }),
      sessionNamespace: new SessionNamespaceCoordinator(join(root, "sessions")),
      createOrdinaryRecoverySession: ({ id, storage, access, intentPolicy, runtimeDependencies }) => create({
        id, ruleset: "cosmic-horror", persona: undefined, storage, access, intentPolicy, runtimeDependencies,
      }),
    },
  };
}

async function request(root: string, dependencies: SessionRuntimeDependencies, path: string, body?: unknown): Promise<Response> {
  return handleRequest(
    new Request(`http://ordinary-action-admission-child${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    undefined, undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {}, {}, authenticator, undefined, undefined, undefined, { mode: "required" }, dependencies,
  );
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function emit(value: Record<string, unknown>): void {
  console.log(`@@ordinary-action-admission@@${JSON.stringify(value)}`);
}

async function hold(root: string, sessionId: string): Promise<void> {
  const current = runtime(root); let calls = 0;
  try {
    const hydrated = await request(root, current.dependencies, `/api/sessions/${sessionId}`);
    if (hydrated.status !== 200) throw new Error(`hold hydration failed: ${hydrated.status}`);
    globalThis.fetch = (async () => {
      calls++;
      emit({ event: "model-entered", calls });
      await new Response(Bun.stdin.stream()).text();
      return completion();
    }) as unknown as typeof fetch;
    const response = await request(root, current.dependencies, `/api/sessions/${sessionId}/action`, FIRST);
    emit({ event: "hold-result", status: response.status, calls, disposition: response.headers.get("X-Ordinary-Action-Disposition"), body: await body(response) });
  } finally {
    for (const session of current.registry.values()) session.close();
  }
}

async function probe(root: string, sessionId: string): Promise<void> {
  const current = runtime(root); let calls = 0; const sent: string[] = [];
  const socket = { send(value: unknown) { sent.push(String(value)); } };
  try {
    const hydrated = await request(root, current.dependencies, `/api/sessions/${sessionId}`);
    if (hydrated.status !== 200) throw new Error(`probe hydration failed: ${hydrated.status}`);
    globalThis.fetch = (async () => { calls++; return completion(); }) as unknown as typeof fetch;
    createWsClient(socket as never, sessionId, "player", "p1");
    const different = await request(root, current.dependencies, `/api/sessions/${sessionId}/action`, DIFFERENT);
    const same = await request(root, current.dependencies, `/api/sessions/${sessionId}/action`, FIRST);
    const session = current.registry.get(sessionId);
    emit({
      event: "probe-result", calls, broadcasts: sent.length,
      round: session?.round,
      actionMessages: session?.getPlayerHistory("p1").messages.filter((message) => message.type === "action").length,
      different: { status: different.status, body: await body(different), retryAfter: different.headers.get("Retry-After") },
      same: { status: same.status, body: await body(same), retryAfter: same.headers.get("Retry-After") },
    });
  } finally {
    removeWsClient(socket as never);
    for (const session of current.registry.values()) session.close();
  }
}

async function replay(root: string, sessionId: string): Promise<void> {
  const current = runtime(root); let calls = 0; const sent: string[] = [];
  const socket = { send(value: unknown) { sent.push(String(value)); } };
  try {
    const hydrated = await request(root, current.dependencies, `/api/sessions/${sessionId}`);
    if (hydrated.status !== 200) throw new Error(`replay hydration failed: ${hydrated.status}`);
    globalThis.fetch = (async () => { calls++; return completion(); }) as unknown as typeof fetch;
    createWsClient(socket as never, sessionId, "player", "p1");
    const response = await request(root, current.dependencies, `/api/sessions/${sessionId}/action`, FIRST);
    emit({ event: "replay-result", status: response.status, calls, broadcasts: sent.length, disposition: response.headers.get("X-Ordinary-Action-Disposition"), body: await body(response) });
  } finally {
    removeWsClient(socket as never);
    for (const session of current.registry.values()) session.close();
  }
}

/** Used by the parent-side stale-read fixture. This is deliberately a fresh
 * process so its completed g0 -> g1 action releases the shared SQLite lease
 * before the paused predecessor can acquire it. */
async function advance(root: string, sessionId: string): Promise<void> {
  const current = runtime(root); let calls = 0;
  try {
    const hydrated = await request(root, current.dependencies, `/api/sessions/${sessionId}`);
    if (hydrated.status !== 200) throw new Error(`advance hydration failed: ${hydrated.status}`);
    globalThis.fetch = (async () => { calls++; return completion(); }) as unknown as typeof fetch;
    const response = await request(root, current.dependencies, `/api/sessions/${sessionId}/action`, FIRST);
    emit({ event: "advance-result", status: response.status, calls, disposition: response.headers.get("X-Ordinary-Action-Disposition"), body: await body(response) });
  } finally {
    for (const session of current.registry.values()) session.close();
  }
}

function stdinSignals() {
  const reader = Bun.stdin.stream().getReader(); const decoder = new TextDecoder(); let pending = "";
  return async (): Promise<string> => {
    for (;;) {
      const end = pending.indexOf("\n");
      if (end >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); return line; }
      const next = await reader.read();
      if (next.done) throw new Error("ordinary admission race child stdin closed before signal");
      pending += decoder.decode(next.value, { stream: true });
    }
  };
}

async function race(root: string, sessionId: string, label: string): Promise<void> {
  const nextSignal = stdinSignals();
  const admission = new OrdinaryActionAdmissionCoordinator(root);
  emit({ event: "race-ready", label });
  if (await nextSignal() !== "go") throw new Error("ordinary admission race start signal is invalid");
  const acquired = admission.acquire({
    sessionId,
    expectedGeneration: 0,
    actionId: `ordinary-process-race-action-${label.padStart(8, "0")}`,
    requestHash: (label === "alpha" ? "a" : "b").repeat(64),
  });
  if (acquired.status !== "acquired") {
    emit({
      event: "race-result", label, status: 503, calls: 0,
      body: { code: acquired.code === "ORDINARY_ACTION_BUSY" ? "ordinary_action_busy" : "ordinary_action_admission_unavailable" },
    });
    if (await nextSignal() !== "release") throw new Error("ordinary admission race loser release signal is invalid");
    return;
  }
  emit({ event: "model-entered", label, calls: 1 });
  if (await nextSignal() !== "release") throw new Error("ordinary admission race winner release signal is invalid");
  acquired.release();
  emit({ event: "race-result", label, status: 200, calls: 1, body: { code: "provider_completed" } });
}

/** Test-only crash fixture: acquire directly, announce the committed lease,
 * then block without a release path. The parent kills this exact child handle
 * to model process loss without touching any unrelated process. */
async function holdLeaseForCrash(root: string, sessionId: string): Promise<void> {
  const admission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"), { leaseTtlMs: 100 });
  const acquired = admission.acquire({
    sessionId,
    expectedGeneration: 0,
    actionId: "ordinary-process-crash-held-lease-0001",
    requestHash: "c".repeat(64),
  });
  if (acquired.status !== "acquired") throw new Error(`crash fixture could not acquire lease: ${acquired.status}`);
  emit({ event: "crash-lease-acquired", expiresAt: acquired.expiresAt });
  await new Response(Bun.stdin.stream()).text();
}

if (import.meta.main) {
  for (const key of ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[key];
  const [phase, root, sessionId, label] = process.argv.slice(2);
  try {
    if (!root || !sessionId) throw new Error("ordinary action admission child requires root and session id");
    if (phase === "hold") await hold(root, sessionId);
    else if (phase === "probe") await probe(root, sessionId);
    else if (phase === "replay") await replay(root, sessionId);
    else if (phase === "advance") await advance(root, sessionId);
    else if (phase === "race") await race(root, sessionId, label ?? "unknown");
    else if (phase === "lease-hold") await holdLeaseForCrash(root, sessionId);
    else throw new Error("ordinary action admission child phase is invalid");
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
