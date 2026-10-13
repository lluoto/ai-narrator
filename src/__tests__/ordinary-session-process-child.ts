import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, ORDINARY_SESSION_IDEMPOTENCY_LIMIT, ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT, OrdinarySessionSnapshotStore, createOrdinarySessionEnvelope, nextOrdinarySessionArchive, ordinaryActionRequestHash, type OrdinaryPersistedActionRecord, type OrdinarySessionEnvelope } from "../api/ordinary-session-snapshot-store";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { createWsClient, removeWsClient } from "../api/ws-handler";

const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const SESSION_ID = "12345678-1234-4123-8123-123456789abc";
const FIRST_ACTION = { input: "inspect process restart boundary", actionId: "ordinary-process-action-0001", expectedGeneration: 0 };
const NEXT_ACTION = { input: "inspect continued process boundary", actionId: "ordinary-process-action-0002", expectedGeneration: 1 };
const authenticator: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-process-owner" } });

type ProcessResult = Record<string, unknown>;

function fail(message: string): never { throw new Error(message); }

function responseBody(value: Response): Promise<Record<string, unknown>> {
  return value.json().then((body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("ordinary process response was not an object");
    return body as Record<string, unknown>;
  });
}

function runtime(root: string, phase: "seed" | "resume" | "seed-cold" | "resume-cold", actionCalls: { value: number }, recoveryCalls: { value: number }): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  const dependencies: SessionRuntimeDependencies = {
    registry,
    ordinaryIntentPolicy: "development_fallback",
    ordinarySnapshots: new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") }),
    ordinarySessionIntentClient: {
      async chat() {
        actionCalls.value++;
        return JSON.stringify({ action: "help" });
      },
    },
  };
  if (phase === "seed" || phase === "seed-cold") {
    dependencies.generateSessionId = () => SESSION_ID;
    dependencies.createOrdinarySession = ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies }) => {
      const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, {
        ...runtimeDependencies,
        ...(sessionIntentClient ? { sessionIntentClient } : {}),
      });
      session.getOpeningScene = async () => "opening";
      return session;
    };
  } else {
    dependencies.createOrdinaryRecoverySession = ({ id, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies }) => {
      recoveryCalls.value++;
      return new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, access, intentPolicy, {
        ...runtimeDependencies,
        ...(sessionIntentClient ? { sessionIntentClient } : {}),
      });
    };
  }
  return { registry, dependencies };
}

async function request(root: string, dependencies: SessionRuntimeDependencies, path: string, body?: unknown): Promise<Response> {
  return handleRequest(
    new Request(`http://ordinary-process${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {},
    {},
    authenticator,
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    dependencies,
  );
}

async function seed(root: string, cold = false): Promise<ProcessResult> {
  const phase = cold ? "seed-cold" : "seed";
  const actionCalls = { value: 0 }; const recoveryCalls = { value: 0 }; const current = runtime(root, phase, actionCalls, recoveryCalls);
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    if (created.status !== 201) fail(`ordinary process create failed: ${created.status}`);
    const createBody = await responseBody(created);
    if (createBody.sessionId !== SESSION_ID || createBody.ordinaryGeneration !== 0) fail("ordinary process create receipt is invalid");
    const action = await request(root, current.dependencies, `/api/sessions/${SESSION_ID}/action`, FIRST_ACTION);
    if (action.status !== 200) fail(`ordinary process first action failed: ${action.status}`);
    const receipt = await responseBody(action);
    if (receipt.ordinaryGeneration !== 1) fail("ordinary process first action generation is invalid");
    let actionCount = 1;
    if (cold) {
      // The create + first action above exercise the real HTTP contract. The
      // remaining compact deterministic publications are a storage seam: no
      // model/gameplay work is needed to prove a fresh process can resolve a
      // receipt that has rolled out of the 128-entry hot window.
      const initialDurable = current.dependencies.ordinarySnapshots!.read(SESSION_ID);
      if (initialDurable.status !== "ok") fail("ordinary process cold predecessor is missing");
      let durable: OrdinarySessionEnvelope = initialDurable.value;
      // The compact loop intentionally avoids replaying 129 model/gameplay
      // actions, but it must still use the same gN fence, one-shot permit,
      // store CAS/readback, and namespace-current CAS as production. A direct
      // store save would leave namespace at g1, and a fresh process would
      // correctly quarantine the later g130 pointer as an unexplained jump.
      const namespace = new SessionNamespaceCoordinator(join(root, "sessions"));
      const namespaceGate = {
        required: true,
        consume: (permit: import("../api/session-namespace-coordinator").SessionNamespacePublicationPermit, expected: import("../api/session-namespace-coordinator").SessionNamespacePublicationPermitExpectation) => namespace.consumePublicationPermit(permit, expected),
      };
      const identity = (envelope: OrdinarySessionEnvelope) => ({ hash: envelope.envelopeHash, generation: envelope.generation, format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT });
      for (let generation = 1; generation < 130; generation++) {
        const previous = durable.idempotency.at(-1)!;
        const actionId = `ordinary-process-cold-${String(generation + 1).padStart(4, "0")}`;
        const response = structuredClone(previous.response) as Record<string, unknown>; response.ordinaryGeneration = generation + 1;
        const record: OrdinaryPersistedActionRecord = {
          actionId, input: "/status", pcId: null, expectedGeneration: generation, generation: generation + 1, status: 200,
          requestHash: ordinaryActionRequestHash(SESSION_ID, actionId, "/status", null, generation), response: response as OrdinaryPersistedActionRecord["response"],
        };
        const archive = nextOrdinarySessionArchive(SESSION_ID, durable.archive, record, durable.snapshot);
        const next = createOrdinarySessionEnvelope({
          kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: SESSION_ID, generation: generation + 1,
          previousEnvelopeHash: durable.envelopeHash, access: durable.access, snapshot: durable.snapshot,
          idempotency: [...durable.idempotency, record].slice(-ORDINARY_SESSION_IDEMPOTENCY_LIMIT), archive,
          replayDirectory: current.dependencies.ordinarySnapshots!.prepareOrdinaryReplayDirectory(SESSION_ID, durable.replayDirectory, record, archive.headHash!),
        });
        const previousIdentity = identity(durable); const nextIdentity = identity(next);
        const published = namespace.publishCommitted({
          kind: "ordinary", sessionId: SESSION_ID, previousIdentity, nextIdentity,
          publish: (permit) => {
            const saved = current.dependencies.ordinarySnapshots!.save(next, { permit }, namespaceGate);
            const reread = current.dependencies.ordinarySnapshots!.read(SESSION_ID);
            if (reread.status === "ok" && reread.value.envelopeHash === next.envelopeHash && reread.value.generation === next.generation) {
              return { status: "published" as const, observedIdentity: identity(reread.value) };
            }
            return saved.status === "indeterminate" ? { status: "indeterminate" as const } : { status: "not-published" as const };
          },
        });
        if ("status" in published) fail(`ordinary process compact namespace publication ${generation + 1} is ${published.status}`);
        durable = next;
      }
      const currentIdentity = namespace.read(SESSION_ID)?.expectedIdentity;
      if (!currentIdentity || currentIdentity.generation !== 130 || currentIdentity.hash !== durable.envelopeHash) {
        fail("ordinary process compact namespace current identity did not advance to generation 130");
      }
      actionCount = 130;
      return { phase, sessionId: SESSION_ID, receipt, actionCalls: actionCalls.value, recoveryCalls: recoveryCalls.value, finalGeneration: actionCount, namespaceGeneration: currentIdentity.generation };
    }
    if (!receipt) fail("ordinary process first receipt is missing");
    return { phase, sessionId: SESSION_ID, receipt, actionCalls: actionCalls.value, recoveryCalls: recoveryCalls.value, finalGeneration: actionCount };
  } finally { for (const session of current.registry.values()) session.close(); }
}

async function resume(root: string, sessionId: string, cold = false): Promise<ProcessResult> {
  if (sessionId !== SESSION_ID) fail(`ordinary process received an unexpected session ID: ${sessionId}`);
  const phase = cold ? "resume-cold" : "resume"; const expectedGeneration = cold ? 130 : 1;
  const actionCalls = { value: 0 }; const recoveryCalls = { value: 0 }; const current = runtime(root, phase, actionCalls, recoveryCalls);
  const sent: string[] = [];
  const fakeSocket = { send(value: unknown) { sent.push(String(value)); } };
  try {
    const state = await request(root, current.dependencies, `/api/sessions/${sessionId}`);
    if (state.status !== 200) fail(`ordinary process recovery GET failed: ${state.status}`);
    const stateBody = await responseBody(state);
    if (stateBody.ordinaryGeneration !== expectedGeneration || recoveryCalls.value !== 1) fail("ordinary process recovery did not use the durable authority");
    createWsClient(fakeSocket as never, sessionId, "observer");
    const duplicate = await request(root, current.dependencies, `/api/sessions/${sessionId}/action`, FIRST_ACTION);
    const duplicateBody = await responseBody(duplicate);
    const duplicateCalls = actionCalls.value; const duplicateBroadcasts = sent.length;
    const conflicting = await request(root, current.dependencies, `/api/sessions/${sessionId}/action`, { ...FIRST_ACTION, input: "/status" });
    const conflictingBody = await responseBody(conflicting);
    const conflictCalls = actionCalls.value; const conflictBroadcasts = sent.length;
    const continued = await request(root, current.dependencies, `/api/sessions/${sessionId}/action`, cold
      ? { input: "/status", actionId: "ordinary-process-cold-continue-0131", expectedGeneration }
      : NEXT_ACTION);
    const continuedBody = await responseBody(continued);
    return {
      phase,
      state: { status: state.status, body: stateBody },
      duplicate: { status: duplicate.status, disposition: duplicate.headers.get("X-Ordinary-Action-Disposition"), body: duplicateBody, actionCalls: duplicateCalls, broadcasts: duplicateBroadcasts },
      conflicting: { status: conflicting.status, body: conflictingBody, actionCalls: conflictCalls, broadcasts: conflictBroadcasts },
      continued: { status: continued.status, body: continuedBody, actionCalls: actionCalls.value, broadcasts: sent.length },
      recoveryCalls: recoveryCalls.value,
    };
  } finally {
    removeWsClient(fakeSocket as never);
    for (const session of current.registry.values()) session.close();
  }
}

if (import.meta.main) {
  const [phase, root, sessionId] = process.argv.slice(2);
  try {
    const result = phase === "seed" ? await seed(root ?? "") : phase === "seed-cold" ? await seed(root ?? "", true)
      : phase === "resume" ? await resume(root ?? "", sessionId ?? "") : phase === "resume-cold" ? await resume(root ?? "", sessionId ?? "", true)
        : fail("ordinary process phase is invalid");
    console.log(`@@ordinary-process@@${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
