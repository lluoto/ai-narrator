import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ChatOptions, LLMLike, Message } from "../llm/client";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotHash } from "../api/compiled-session-snapshot";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { createEnvironmentCompilerAuthenticator, createEnvironmentPlayerDelivery, handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CompiledIntentAdmissionCoordinator } from "../api/compiled-intent-admission";
import { CompiledIntentReplayStore } from "../api/compiled-intent-replay";
import { CompiledNarrationLedger } from "../api/compiled-narration-ledger";
import {
  canonicalJson,
} from "../api/compiled-session-snapshot";
import {
  compiledPlayerNarrationPublicRequestHash,
  compiledPlayerNarrationTopicTokenHash,
  compiledPlayerNarrationV2RequestHash,
} from "../api/game-session";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";

const OPERATOR_TOKEN = "o".repeat(48);
const KEEPER_TOKEN = "k".repeat(48);
const DELIVERY_SECRET = "player_intent_delivery_secret_".padEnd(48, "d");
const CLAIM_ID = "c".repeat(43);
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";

function v2CandidateHash(candidate: any): string {
  const base = {
    sessionId: candidate.sessionId,
    bundleId: candidate.bundleId,
    actionId: candidate.actionId,
    expectedGeneration: candidate.expectedGeneration,
    nextGeneration: candidate.nextGeneration,
    predecessorSnapshotHash: candidate.predecessorSnapshotHash,
    requestHash: candidate.requestHash,
    playerRequestHash: candidate.playerRequestHash,
    frameHash: candidate.frameHash,
    snapshotHash: candidate.snapshot.snapshotHash,
  };
  return createHash("sha256").update(canonicalJson({
    domain: "compiled-narration-candidate-v2",
    ...base,
    topicTokenHash: candidate.topicTokenHash,
    topicBindingHash: candidate.topicBindingHash,
  })).digest("hex");
}

class FakeLLM implements LLMLike {
  calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];

  constructor(private readonly reply: string | Error) {}

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.calls.push({ messages, options });
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("expected player delivery cookie");
  return value.split(";", 1)[0]!;
}

async function createDeliveredSession(root: string) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = saveTrustedFixtureBundle(catalog, fixture);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const authenticator = createEnvironmentCompilerAuthenticator({
    COMPILER_OPERATOR_BEARER_TOKEN: OPERATOR_TOKEN,
    COMPILER_KEEPER_BEARER_TOKEN: KEEPER_TOKEN,
  });
  const delivery = createEnvironmentPlayerDelivery({
    COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
    COMPILER_PLAYER_DELIVERY_ROOT: join(root, "delivery"),
    COMPILER_PUBLIC_ORIGIN: "https://example.test",
  });
  const createdResponse = await handleRequest(new Request("https://example.test/api/sessions/compiled", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
    body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Intent player" }),
  }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticator, undefined, undefined, delivery);
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json() as { sessionId: string; playerInvitation?: { invite: string } };
  if (!created.playerInvitation) throw new Error("expected player invitation");
  const claim = await handleRequest(new Request(`https://example.test/api/sessions/${created.sessionId}/player-invitations/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.test" },
    body: JSON.stringify({ invite: created.playerInvitation.invite, claimId: CLAIM_ID }),
  }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticator, undefined, undefined, delivery);
  expect(claim.status).toBe(204);
  return { root, fixture, catalog, snapshots, authenticator, delivery, sessionId: created.sessionId, cookie: cookieFrom(claim) };
}

async function playerRequest(
  built: Awaited<ReturnType<typeof createDeliveredSession>>,
  suffix: string,
  init: RequestInit = {},
  intentOptions: { llm?: LLMLike; isLlmEnabled?: () => boolean } = {},
  origin = "https://example.test",
  sessionRuntime?: SessionRuntimeDependencies,
) {
  return handleRequest(new Request(`${origin}/api/sessions/${built.sessionId}/${suffix}`, init), built.catalog, built.snapshots,
    { careerRoot: join(built.root, "careers") }, intentOptions, {}, built.authenticator, undefined, undefined, built.delivery, undefined, sessionRuntime);
}

async function ownerIntentRequest(
  built: Awaited<ReturnType<typeof createDeliveredSession>>,
  init: RequestInit,
  intentOptions: { llm?: LLMLike; isLlmEnabled?: () => boolean },
  sessionRuntime?: SessionRuntimeDependencies,
) {
  return handleRequest(new Request(`https://example.test/api/sessions/${built.sessionId}/compiled/intents`, init), built.catalog, built.snapshots,
    { careerRoot: join(built.root, "careers") }, intentOptions, {}, built.authenticator, undefined, undefined, built.delivery, undefined, sessionRuntime);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function playerView(built: Awaited<ReturnType<typeof createDeliveredSession>>) {
  const response = await playerRequest(built, "player-view", { headers: { Cookie: built.cookie } });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ generation: number; actions: Array<{ choiceId: string; label: string }> }>;
}

describe("compiled player natural-language intents", () => {
  it("replays one successful owner classification to a restarted player facade without another provider call", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-durable-replay-"));
    let calls = 0;
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods
        .find((method: any) => method.id === "find_parent")!.id;
      const llm: LLMLike = {
        async chat() {
          calls += 1;
          return JSON.stringify({ kind: "selected", mechanismId });
        },
      };
      const options = { llm, isLlmEnabled: () => true };
      const owner = await ownerIntentRequest(built, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
        body: JSON.stringify({ input: "I search here", pcId: "p1", expectedGeneration: view.generation }),
      }, options);
      expect(owner.status).toBe(200);
      expect(await owner.json()).toMatchObject({ status: "selected", mechanismId, generation: view.generation });
      const replayDatabase = new Database(join(root, "careers", ".runtime-session-namespace", ".compiled-intent-replay.sqlite"));
      const persistedReplay = JSON.stringify(replayDatabase.query<Record<string, unknown>, []>("SELECT * FROM compiled_intent_replay_records").all());
      replayDatabase.close();
      for (const forbidden of ["I search here", "Search here", mechanismId, "choice_"]) expect(persistedReplay).not.toContain(forbidden);

      // A new registry + coordinator represents a separate server process.
      // The player route must reuse the exact classification but keep its
      // opaque response projection (and never reveal mechanismId).
      const restartedRuntime: SessionRuntimeDependencies = {
        registry: new Map(),
        compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(join(root, "careers", ".runtime-session-namespace")),
      };
      const player = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "I search here", expectedGeneration: view.generation }),
      }, options, "https://example.test", restartedRuntime);
      expect(player.status).toBe(200);
      const playerBody = await player.json() as Record<string, unknown>;
      expect(playerBody).toMatchObject({ status: "selected", generation: view.generation, action: { choiceId: expect.any(String) } });
      expect(JSON.stringify(playerBody)).not.toContain("mechanismId");
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not cross-hit different inputs or a new durable generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-replay-identity-"));
    let calls = 0;
    const llm: LLMLike = { async chat() { calls += 1; return '{"kind":"no_match"}'; } };
    try {
      const built = await createDeliveredSession(root);
      const options = { llm, isLlmEnabled: () => true };
      const request = (input: string, expectedGeneration: number) => ownerIntentRequest(built, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
        body: JSON.stringify({ input, pcId: "p1", expectedGeneration }),
      }, options);
      expect((await request("first distinct request", 0)).status).toBe(200);
      expect((await request("second distinct request", 0)).status).toBe(200);
      expect(calls).toBe(2);

      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods
        .find((method: any) => method.id === "find_parent")!.id;
      const advanced = await handleRequest(new Request(`https://example.test/api/sessions/${built.sessionId}/compiled/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
        body: JSON.stringify({ mechanismId, pcId: "p1", actionId: "018f14a2-c2be-7b73-b291-6e64eaf78684", expectedGeneration: 0 }),
      }), built.catalog, built.snapshots, { careerRoot: join(root, "careers") }, {}, {}, built.authenticator, undefined, undefined, built.delivery);
      expect(advanced.status).toBe(200);
      expect((await request("first distinct request", 1)).status).toBe(200);
      expect(calls).toBe(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a full replay scope before provider work, but replays exact hits and clears only on a new generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-replay-capacity-"));
    let calls = 0;
    const llm: LLMLike = { async chat() { calls += 1; return '{"kind":"no_match"}'; } };
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const replayRoot = join(root, "careers", ".runtime-session-namespace");
      const runtime: SessionRuntimeDependencies = {
        compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(replayRoot),
        compiledIntentReplay: new CompiledIntentReplayStore(replayRoot, { maxRecordsPerScope: 1 }),
      };
      const request = (input: string, expectedGeneration: number) => ownerIntentRequest(built, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
        body: JSON.stringify({ input, pcId: "p1", expectedGeneration }),
      }, { llm, isLlmEnabled: () => true }, runtime);
      expect((await request("capacity first", view.generation)).status).toBe(200);
      expect(calls).toBe(1);
      expect((await request("capacity second", view.generation)).status).toBe(503);
      expect(calls).toBe(1);
      expect((await request("capacity first", view.generation)).status).toBe(200);
      expect(calls).toBe(1);

      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods
        .find((method: any) => method.id === "find_parent")!.id;
      const advanced = await handleRequest(new Request(`https://example.test/api/sessions/${built.sessionId}/compiled/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
        body: JSON.stringify({ mechanismId, pcId: "p1", actionId: "018f14a2-c2be-7b73-b291-6e64eaf78685", expectedGeneration: view.generation }),
      }), built.catalog, built.snapshots, { careerRoot: join(root, "careers") }, {}, {}, built.authenticator, undefined, undefined, built.delivery);
      expect(advanced.status).toBe(200);
      expect((await request("capacity second", view.generation + 1)).status).toBe(200);
      expect(calls).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rechecks replay after acquiring a lease when another process settled in the miss-to-acquire window", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-replay-race-"));
    let calls = 0;
    const llm: LLMLike = { async chat() { calls += 1; return '{"kind":"no_match"}'; } };
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const replayRoot = join(root, "careers", ".runtime-session-namespace");
      const settledByOtherProcess = new CompiledIntentReplayStore(replayRoot);
      let reads = 0;
      const interleavedReplay = new class extends CompiledIntentReplayStore {
        override read(value: Parameters<CompiledIntentReplayStore["read"]>[0]) {
          reads += 1;
          if (reads === 1) {
            // Simulate B observing absence immediately before A's validated
            // provider result commits and A releases. B must recheck after
            // acquiring the now-free lease rather than call its own provider.
            expect(settledByOtherProcess.save(value, { kind: "no_match", mechanismKeys: [] }).status).toBe("stored");
            return { status: "absent" as const };
          }
          return super.read(value);
        }
      }(replayRoot);
      const response = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "race between replay miss and acquire", expectedGeneration: view.generation }),
      }, { llm, isLlmEnabled: () => true }, "https://example.test", {
        compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(replayRoot),
        compiledIntentReplay: interleavedReplay,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "no_match", generation: view.generation });
      expect(reads).toBe(2);
      expect(calls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("quarantines provider work when the durable replay save cannot be acknowledged", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-replay-save-failure-"));
    let calls = 0;
    const llm: LLMLike = { async chat() { calls += 1; return '{"kind":"no_match"}'; } };
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const admissionRoot = join(root, "careers", ".runtime-session-namespace");
      const failingReplay = new CompiledIntentReplayStore(admissionRoot, {}, {
        connectionFactory(file, flags) {
          const database = new Database(file, flags);
          return {
            run(sql: string, values: readonly (string | number)[] = []) {
              if (sql.startsWith("INSERT INTO compiled_intent_replay_records")) throw new Error("injected replay save failure");
              if (values.length) database.run(sql, [...values]); else database.run(sql);
            },
            get<T>(sql: string, values: readonly (string | number)[] = []) {
              return values.length ? database.query(sql).get(...values) as T | undefined : database.query(sql).get() as T | undefined;
            },
            pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
              const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
              return row ? Object.values(row)[0] : undefined;
            },
            close(throwOnError: true) { database.close(throwOnError); },
          };
        },
      });
      const init = {
        method: "POST" as const,
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "save failure must not replay provider", expectedGeneration: view.generation }),
      };
      const first = await playerRequest(built, "player-intents", init, { llm, isLlmEnabled: () => true }, "https://example.test", {
        compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(admissionRoot),
        compiledIntentReplay: failingReplay,
      });
      expect(first.status).toBe(503);
      expect(calls).toBe(1);
      const second = await playerRequest(built, "player-intents", init, { llm, isLlmEnabled: () => true }, "https://example.test", {
        compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(admissionRoot),
        compiledIntentReplay: new CompiledIntentReplayStore(admissionRoot),
      });
      expect(second.status).toBe(503);
      expect(second.headers.get("Retry-After")).toBe("60");
      expect(calls).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("classifies through the authenticated same-origin player facade, returns only opaque action data, and leaves execution to player-actions", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-"));
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id;
      const selected = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "I search here", expectedGeneration: view.generation }),
      }, { llm: new FakeLLM(`{"kind":"selected","mechanismId":"${mechanismId}"}`), isLlmEnabled: () => true });
      expect(selected.status).toBe(200);
      expect(selected.headers.get("cache-control")).toBe("no-store");
      expect(selected.headers.get("access-control-allow-origin")).toBeNull();
      const result = await selected.json() as any;
      const selectedAction = structuredClone(result);
      expect(result).toMatchObject({
        status: "selected",
        action: expect.objectContaining({ choiceId: expect.any(String), label: "Search here" }),
        topicBound: expect.stringMatching(/^[a-f0-9]{64}$/),
        generation: view.generation,
      });
      const text = JSON.stringify(result);
      for (const forbidden of ["mechanismId", "command", "@compiled", "find_parent", "state", "check.skill", "pcId"]) expect(text).not.toContain(forbidden);

      const executed = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selectedAction.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selectedAction.generation,
          topicBound: selectedAction.topicBound,
          playerInput: "I search here",
        }),
      }, {}, "https://example.test", {
        compiledNarrationOptions: {
          llm: new FakeLLM('{"text":"Ada searches the reviewed threshold."}'),
          isLlmEnabled: () => true,
        },
      });
      expect(executed.status).toBe(200);
      expect((await executed.json() as any).view.generation).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes an opaque v2 topic binding and the ephemeral player question to the later narration prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-narration-topic-"));
    const playerQuestion = "RAW_TOPIC_SENTINEL_7c6ce32d beneath the orchard for my missing father.";
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods
        .find((method: any) => method.id === "find_parent")!.id;
      const classifier = new FakeLLM(`{"kind":"selected","mechanismId":"${mechanismId}"}`);
      const narrator = new FakeLLM('{"text":"Ada pauses at the reviewed threshold."}');

      const selected = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: playerQuestion, expectedGeneration: view.generation }),
      }, { llm: classifier, isLlmEnabled: () => true });
      expect(selected.status).toBe(200);
      const selection = await selected.json() as { status: string; action: { choiceId: string }; generation: number; topicBound?: string };
      expect(selection.status).toBe("selected");
      expect(selection.topicBound).toEqual(expect.any(String));

      const executed = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
          playerInput: playerQuestion,
        }),
      }, {}, "https://example.test", {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
      });
      expect(executed.status).toBe(200);
      expect(narrator.calls).toHaveLength(1);
      expect(JSON.stringify(narrator.calls[0]!.messages)).toContain(playerQuestion);
      // The narrator's output deliberately does not echo the request, so this
      // scans input persistence rather than attempting to constrain arbitrary
      // model output semantics.
      const ledgerDb = new Database(join(built.snapshots.root, ".compiled-narration-ledger.sqlite"));
      const ledgerRows = ledgerDb.query<Record<string, unknown>, []>("SELECT candidate_json, receipt_json FROM compiled_narration_records").all();
      ledgerDb.close();
      expect(JSON.stringify(ledgerRows)).not.toContain(playerQuestion);
      const snapshot = built.snapshots.read(built.sessionId);
      expect(snapshot.status).toBe("ok");
      expect(JSON.stringify(snapshot)).not.toContain(playerQuestion);
      const replayDb = new Database(join(root, "careers", ".runtime-session-namespace", ".compiled-intent-replay.sqlite"));
      const replayRows = replayDb.query<Record<string, unknown>, []>("SELECT * FROM compiled_intent_replay_records").all();
      replayDb.close();
      expect(JSON.stringify(replayRows)).not.toContain(playerQuestion);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replays a v2 receipt after later generations without another narrator call", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-v2-late-receipt-"));
    const playerQuestion = "I search beneath the orchard for my missing father.";
    try {
      const built = await createDeliveredSession(root);
      const initial = await playerView(built);
      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods
        .find((method: any) => method.id === "find_parent")!.id;
      const classifier = new FakeLLM(`{"kind":"selected","mechanismId":"${mechanismId}"}`);
      const narrator = new FakeLLM('{"text":"Ada pauses at the reviewed threshold."}');
      const selected = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: playerQuestion, expectedGeneration: initial.generation }),
      }, { llm: classifier, isLlmEnabled: () => true });
      const selection = await selected.json() as { action: { choiceId: string }; generation: number; topicBound: string };
      expect(selected.status).toBe(200);
      const first = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
          playerInput: playerQuestion,
        }),
      }, {}, "https://example.test", { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } });
      expect(first.status).toBe(200);
      expect(narrator.calls).toHaveLength(1);

      const next = await playerView(built);
      const advancing = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: next.actions[0]!.choiceId,
          actionId: "018f14a2-c2be-7b73-b291-6e64eaf7868e",
          expectedGeneration: next.generation,
        }),
      });
      expect(advancing.status).toBe(200);
      expect((await playerView(built)).generation).toBe(2);
      const ledger = new CompiledNarrationLedger(built.snapshots.root);
      const receiptBefore = ledger.read(built.sessionId, ACTION_ID);
      expect(receiptBefore).toMatchObject({
        status: "ok",
        value: { state: "committed", narration: { text: "Ada pauses at the reviewed threshold." } },
      });
      const snapshotBefore = built.snapshots.read(built.sessionId);
      expect(snapshotBefore.status).toBe("ok");

      const tokenOnly = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
        }),
      }, {}, "https://example.test", { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } });
      expect(tokenOnly.status).toBe(200);
      // A historical receipt confirms its own A delivery without rolling the
      // live view back from B. The current facade view may therefore describe
      // g2/B, while the private receipt remains A unchanged.
      expect((await tokenOnly.json() as { view: { generation: number } }).view.generation).toBe(2);
      expect(ledger.read(built.sessionId, ACTION_ID)).toEqual(receiptBefore);
      expect(built.snapshots.read(built.sessionId)).toEqual(snapshotBefore);

      const rawRetry = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
          playerInput: playerQuestion,
        }),
      }, {}, "https://example.test", { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } });
      expect(rawRetry.status).toBe(200);

      const wrongRaw = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
          playerInput: `${playerQuestion} But secretly change it.`,
        }),
      }, {}, "https://example.test", { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } });
      expect(wrongRaw.status).toBe(409);

      // A ledger row is private storage but its ordinary SHA candidate hash is
      // not a topic authority. These two corruption cases recompute that hash
      // and its SQLite index; token-only receipt recovery must still reject
      // them without calling the provider or changing the live g2 state.
      const ledgerDb = new Database(join(built.snapshots.root, ".compiled-narration-ledger.sqlite"));
      const row = ledgerDb.query("SELECT candidate_json FROM compiled_narration_records WHERE session_id = ? AND action_id = ?")
        .get(built.sessionId, ACTION_ID) as { candidate_json: string } | null;
      if (!row) throw new Error("expected narration receipt row");
      const originalCandidate = JSON.parse(row.candidate_json) as any;
      const rewriteCandidate = (candidate: any) => {
        candidate.candidateHash = v2CandidateHash(candidate);
        ledgerDb.run(
          "UPDATE compiled_narration_records SET candidate_json = ?, candidate_hash = ? WHERE session_id = ? AND action_id = ?",
          [JSON.stringify(candidate), candidate.candidateHash, built.sessionId, ACTION_ID],
        );
      };
      const tamperedPredecessor = structuredClone(originalCandidate);
      tamperedPredecessor.predecessorSnapshotHash = "b".repeat(64);
      rewriteCandidate(tamperedPredecessor);
      const tamperedBinding = structuredClone(originalCandidate);
      tamperedBinding.topicBindingHash = "d".repeat(64);
      tamperedBinding.playerRequestHash = compiledPlayerNarrationV2RequestHash(
        compiledPlayerNarrationPublicRequestHash(selection.action.choiceId, ACTION_ID, selection.generation),
        compiledPlayerNarrationTopicTokenHash(selection.topicBound),
        tamperedBinding.topicBindingHash,
      );
      tamperedBinding.candidateHash = v2CandidateHash(tamperedBinding);
      const tamperedCharacterBefore = structuredClone(originalCandidate);
      tamperedCharacterBefore.snapshot.idempotency.at(-1).characterBefore.sheet.name = "Tampered predecessor character";
      tamperedCharacterBefore.snapshot.snapshotHash = compiledSessionSnapshotHash(tamperedCharacterBefore.snapshot);
      tamperedCharacterBefore.candidateHash = v2CandidateHash(tamperedCharacterBefore);

      const tokenOnlyBody = () => ({
        choiceId: selection.action.choiceId,
        actionId: ACTION_ID,
        expectedGeneration: selection.generation,
        topicBound: selection.topicBound,
      });
      const tamperedStatuses: number[] = [];
      tamperedStatuses.push((await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify(tokenOnlyBody()),
      }, {}, "https://example.test", { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } })).status);
      rewriteCandidate(tamperedBinding);
      tamperedStatuses.push((await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify(tokenOnlyBody()),
      }, {}, "https://example.test", { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } })).status);
      rewriteCandidate(tamperedCharacterBefore);
      ledgerDb.close();
      tamperedStatuses.push((await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify(tokenOnlyBody()),
      }, {}, "https://example.test", { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } })).status);
      expect(narrator.calls).toHaveLength(1);
      expect(built.snapshots.read(built.sessionId)).toEqual(snapshotBefore);
      expect(tamperedStatuses).toEqual([409, 409, 409]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires exact raw v2 re-entry for a same-generation receipt after restart without another narrator call", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-v2-receipt-restart-"));
    const playerQuestion = "I search beneath the orchard for my missing father.";
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods
        .find((method: any) => method.id === "find_parent")!.id;
      const classifier = new FakeLLM(`{"kind":"selected","mechanismId":"${mechanismId}"}`);
      const narrator = new FakeLLM('{"text":"Ada keeps the exact durable receipt."}');
      const selected = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: playerQuestion, expectedGeneration: view.generation }),
      }, { llm: classifier, isLlmEnabled: () => true });
      const selection = await selected.json() as { action: { choiceId: string }; generation: number; topicBound: string };
      expect(selected.status).toBe(200);

      const crashingLedger = new CompiledNarrationLedger(built.snapshots.root);
      const saveReceipt = crashingLedger.saveReceipt.bind(crashingLedger);
      crashingLedger.saveReceipt = ((candidate, narration) => {
        const saved = saveReceipt(candidate, narration);
        if (saved.status === "stored") throw new Error("simulate crash after durable receipt before snapshot commit");
        return saved;
      }) as typeof crashingLedger.saveReceipt;
      const interrupted = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
          playerInput: playerQuestion,
        }),
      }, {}, "https://example.test", {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
        compiledNarrationLedger: crashingLedger,
      });
      expect(interrupted.status).toBe(503);
      expect(narrator.calls).toHaveLength(1);
      expect(new CompiledNarrationLedger(built.snapshots.root).read(built.sessionId, ACTION_ID)).toMatchObject({
        status: "ok",
        value: { state: "receipt", narration: { text: "Ada keeps the exact durable receipt." } },
      });
      expect((await playerView(built)).generation).toBe(view.generation);

      const restarted = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
        }),
      }, {}, "https://example.test", {
        registry: new Map(),
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
        compiledNarrationLedger: new CompiledNarrationLedger(built.snapshots.root),
      });
      expect(restarted.status).toBe(409);
      expect(narrator.calls).toHaveLength(1);

      const wrongRawRestart = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
          playerInput: `${playerQuestion} with a forged change`,
        }),
      }, {}, "https://example.test", {
        registry: new Map(),
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
        compiledNarrationLedger: new CompiledNarrationLedger(built.snapshots.root),
      });
      expect(wrongRawRestart.status).toBe(409);
      expect(narrator.calls).toHaveLength(1);

      const rawRestart = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: selection.action.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
          playerInput: playerQuestion,
        }),
      }, {}, "https://example.test", {
        registry: new Map(),
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
        compiledNarrationLedger: new CompiledNarrationLedger(built.snapshots.root),
      });
      expect(rawRestart.status).toBe(200);
      expect(narrator.calls).toHaveLength(1);
      expect((await rawRestart.json() as { view: { generation: number } }).view.generation).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a player action missing its v2 topic binding malformed before narration work", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-missing-topic-binding-"));
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const narrator = new FakeLLM('{"text":"must not be called"}');
      const executed = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: view.actions[0]!.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: view.generation,
          playerInput: "I search beneath the orchard for my missing father.",
        }),
      }, {}, "https://example.test", {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
      });
      expect(narrator.calls).toHaveLength(0);
      expect(executed.status).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a shape-valid v2 player action with a bogus topic binding before narration work", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-bogus-topic-binding-"));
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const narrator = new FakeLLM('{"text":"must not be called"}');
      const executed = await playerRequest(built, "player-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({
          choiceId: view.actions[0]!.choiceId,
          actionId: ACTION_ID,
          expectedGeneration: view.generation,
          topicBound: "a".repeat(64),
          playerInput: "I search beneath the orchard for my missing father.",
        }),
      }, {}, "https://example.test", {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
      });
      expect(narrator.calls).toHaveLength(0);
      expect(executed.status).toBe(409);
      expect((await playerView(built)).generation).toBe(view.generation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("admits only one same-generation classification across the owner and player routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-admission-"));
    const provider = deferred<string>();
    const entered = deferred<void>();
    let calls = 0;
    const llm: LLMLike = {
      async chat() {
        calls += 1;
        entered.resolve();
        return provider.promise;
      },
    };
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const options = { llm, isLlmEnabled: () => true };
      const owner = ownerIntentRequest(built, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
        body: JSON.stringify({ input: "I search here", pcId: "p1", expectedGeneration: view.generation }),
      }, options);
      const player = playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "I search here", expectedGeneration: view.generation }),
      }, options);
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        expect(calls).toBe(1);
      } finally {
        provider.resolve('{"kind":"no_match"}');
      }
      const [ownerResponse, playerResponse] = await Promise.all([owner, player]);
      expect([ownerResponse.status, playerResponse.status].sort()).toEqual([200, 429]);
      const refused = ownerResponse.status === 429 ? ownerResponse : playerResponse;
      expect(refused.headers.get("Retry-After")).toBe("1");
      expect(JSON.stringify(await refused.json())).not.toContain("mechanismId");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let a same-root injected filename split the owner/player admission domain", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-policy-identity-"));
    const provider = deferred<string>();
    const entered = deferred<void>();
    let calls = 0;
    const llm: LLMLike = {
      async chat() { calls += 1; entered.resolve(); return provider.promise; },
    };
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const admissionRoot = join(root, "careers", ".runtime-session-namespace");
      const primary = new CompiledIntentAdmissionCoordinator(admissionRoot);
      // Simulate a misconfigured trusted host. The wrapper must ignore this
      // unsupported field rather than silently creating a second SQLite lock.
      const shadow = new CompiledIntentAdmissionCoordinator(admissionRoot, {}, { fileName: ".shadow-compiled-intent.sqlite" } as any);
      const options = { llm, isLlmEnabled: () => true };
      const owner = ownerIntentRequest(built, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
        body: JSON.stringify({ input: "I search here", pcId: "p1", expectedGeneration: view.generation }),
      }, options, { compiledIntentAdmission: primary });
      const player = playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "I search here", expectedGeneration: view.generation }),
      }, options, "https://example.test", { compiledIntentAdmission: shadow });
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        expect(calls).toBe(1);
      } finally { provider.resolve('{"kind":"no_match"}'); }
      const [ownerResponse, playerResponse] = await Promise.all([owner, player]);
      expect(shadow.file).toBe(primary.file);
      expect([ownerResponse.status, playerResponse.status].sort()).toEqual([200, 429]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("passes a disconnected player Request signal to the provider and fails safely", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-cancel-"));
    const entered = deferred<void>();
    let seen: AbortSignal | undefined;
    let fallbackResolve: ((value: string) => void) | undefined;
    const llm: LLMLike = {
      async chat(_messages, options) {
        seen = options?.signal;
        entered.resolve();
        return new Promise<string>((resolve, reject) => {
          fallbackResolve = resolve;
          options?.signal?.addEventListener("abort", () => reject(new Error("caller disconnected")), { once: true });
        });
      },
    };
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const controller = new AbortController();
      const pending = playerRequest(built, "player-intents", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "I search here", expectedGeneration: view.generation }),
      }, { llm, isLlmEnabled: () => true });
      await entered.promise;
      controller.abort();
      await Promise.resolve();
      try {
        expect(seen).toBeDefined();
        expect(seen!.aborted).toBe(true);
      } finally {
        fallbackResolve?.('{"kind":"no_match"}');
      }
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "PLAYER_INTENT_MODEL_UNAVAILABLE" }, generation: view.generation });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines an abort-ignoring provider before a competing request can enter it", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-abort-quarantine-"));
    const entered = deferred<void>();
    const provider = deferred<string>();
    let calls = 0;
    let providerSawAbort = false;
    const llm: LLMLike = {
      async chat(_messages, options) {
        calls += 1;
        options?.signal?.addEventListener("abort", () => { providerSawAbort = true; }, { once: true });
        entered.resolve();
        // Deliberately ignore abort; the request handler must retain/quarantine
        // the durable fence instead of treating this pending promise as done.
        return provider.promise;
      },
    };
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const runtime: SessionRuntimeDependencies = {
        compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(join(root, "careers", ".runtime-session-namespace")),
      };
      const firstController = new AbortController();
      const input = { input: "I search here", expectedGeneration: view.generation };
      const first = playerRequest(built, "player-intents", {
        method: "POST", signal: firstController.signal,
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify(input),
      }, { llm, isLlmEnabled: () => true }, "https://example.test", runtime);
      await entered.promise;
      firstController.abort();
      await Promise.resolve();
      expect(providerSawAbort).toBe(true);
      const contender = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify(input),
      }, { llm, isLlmEnabled: () => true }, "https://example.test", runtime);
      expect(contender.status).toBe(503);
      expect(contender.headers.get("Retry-After")).toBe("60");
      expect(calls).toBe(1);
      provider.resolve('{"kind":"no_match"}');
      expect((await first).status).toBe(503);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("allows only an authenticated operator to recover a pre-existing compiled intent quarantine", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-recovery-"));
    try {
      const built = await createDeliveredSession(root);
      const rootDomain = join(root, "careers", ".runtime-session-namespace");
      const admission = new CompiledIntentAdmissionCoordinator(rootDomain);
      const held = admission.acquire({ sessionId: built.sessionId, expectedGeneration: 0, input: "uncertain provider work" });
      expect(held.status).toBe("acquired");
      if (held.status !== "acquired") throw new Error("expected admission");
      const runtime: SessionRuntimeDependencies = { compiledIntentAdmission: admission };
      const request = (token: string, body?: string) => handleRequest(new Request(`https://example.test/api/sessions/${built.sessionId}/compiled-intent-admission/recover`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body }),
      }), built.catalog, built.snapshots, { careerRoot: join(root, "careers") }, {}, {}, built.authenticator, undefined, undefined, built.delivery, undefined, runtime);
      expect((await request(KEEPER_TOKEN)).status).toBe(403);
      const active = await request(OPERATOR_TOKEN);
      expect(active.status).toBe(503);
      expect(await active.json()).toMatchObject({ code: "compiled_intent_busy", generation: 0 });
      held.quarantine();
      const recovered = await request(OPERATOR_TOKEN);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ status: "recovered", code: "compiled_intent_admission_recovered", generation: 0 });
      const noBody = await request(OPERATOR_TOKEN, "{}");
      expect(noBody.status).toBe(400);
      expect(await noBody.json()).toEqual({ code: "compiled_intent_admission_recovery_body_forbidden" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the durable namespace and snapshot generation after await, not only its local registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-durable-recheck-"));
    const entered = deferred<void>();
    const provider = deferred<string>();
    const llm: LLMLike = {
      async chat() { entered.resolve(); return provider.promise; },
    };
    try {
      const built = await createDeliveredSession(root);
      const rootDomain = join(root, "careers", ".runtime-session-namespace");
      const firstRuntime: SessionRuntimeDependencies = {
        registry: new Map(),
        compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(rootDomain),
      };
      const independentRuntime: SessionRuntimeDependencies = { registry: new Map() };
      const view = await playerRequest(built, "player-view", { headers: { Cookie: built.cookie } }, {}, "https://example.test", firstRuntime)
        .then(async (response) => await response.json() as { generation: number });
      const pending = playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "I search here", expectedGeneration: view.generation }),
      }, { llm, isLlmEnabled: () => true }, "https://example.test", firstRuntime);
      await entered.promise;
      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id;
      const committed = await handleRequest(new Request(`https://example.test/api/sessions/${built.sessionId}/compiled/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
        body: JSON.stringify({ mechanismId, pcId: "p1", actionId: "018f14a2-c2be-7b73-b291-6e64eaf7869a", expectedGeneration: view.generation }),
      }), built.catalog, built.snapshots, { careerRoot: join(root, "careers") }, {}, {}, built.authenticator, undefined, undefined, built.delivery, undefined, independentRuntime);
      expect(committed.status).toBe(200);
      provider.resolve('{"kind":"no_match"}');
      const stale = await pending;
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: { code: "PLAYER_INTENT_CONFLICT" }, generation: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects missing cookies, cross-origin requests, and malformed bounded bodies before model work", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-refusal-"));
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const llm = new FakeLLM('{"kind":"no_match"}');
      const attempts: Array<{ headers: Record<string, string> }> = [
        { headers: { "Content-Type": "application/json", Origin: "https://example.test" } },
        { headers: { "Content-Type": "application/json", Origin: "https://attacker.test", Cookie: built.cookie } },
      ];
      for (const attempt of attempts) {
        let pulls = 0;
        const response = await playerRequest(built, "player-intents", {
          method: "POST",
          headers: attempt.headers,
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ input: "search", expectedGeneration: view.generation })));
              controller.close();
            },
          }, { highWaterMark: 0 }),
        }, { llm, isLlmEnabled: () => true });
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(pulls).toBe(0);
        expect(existsSync(join(root, "careers", ".runtime-session-namespace", ".compiled-intent-replay.sqlite"))).toBe(false);
      }
      for (const body of [
        { input: "search", expectedGeneration: view.generation, extra: true },
        { input: "x".repeat(1001), expectedGeneration: view.generation },
      ]) {
        const response = await playerRequest(built, "player-intents", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
          body: JSON.stringify(body),
        }, { llm, isLlmEnabled: () => true });
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      const oversized = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "x".repeat(8_192), expectedGeneration: view.generation }),
      }, { llm, isLlmEnabled: () => true });
      expect(oversized.status).toBe(413);
      expect(llm.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns safe selected, ambiguous, no-match, invalid, unavailable-model, and model-error classifications without persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-results-"));
    try {
      const built = await createDeliveredSession(root);
      let view = await playerView(built);
      const payload: any = built.fixture.resolved.artifact.payload;
      const move = async (choiceLabel: string, actionId: string) => {
        const response = await playerRequest(built, "player-actions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
          body: JSON.stringify({ choiceId: view.actions.find((action) => action.label === choiceLabel)!.choiceId, actionId, expectedGeneration: view.generation }),
        });
        expect(response.status).toBe(200);
        view = (await response.json() as any).view;
      };
      await move("Search here", "018f14a2-c2be-7b73-b291-6e64eaf78690");
      await move("Go to another area", "018f14a2-c2be-7b73-b291-6e64eaf78691");
      const searchId = payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_child")!.id;
      const travelId = payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "archive_exit")!.id;
      const request = (input: string) => ({
        method: "POST" as const,
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input, expectedGeneration: view.generation }),
      });
      const snapshotBefore = built.snapshots.read(built.sessionId);
      const disabled = await playerRequest(built, "player-intents", request("disabled intent"), { llm: new FakeLLM('{"kind":"selected","mechanismId":"ignored"}'), isLlmEnabled: () => false });
      expect(disabled.status).toBe(503);
      expect(await disabled.json()).toEqual({ error: { code: "PLAYER_INTENT_MODEL_UNAVAILABLE" }, generation: view.generation });
      const noMatch = await playerRequest(built, "player-intents", request("no match intent"), { llm: new FakeLLM('{"kind":"no_match"}'), isLlmEnabled: () => true });
      expect(await noMatch.json()).toEqual({ status: "no_match", generation: view.generation });
      const ambiguous = await playerRequest(built, "player-intents", request("ambiguous intent"), {
        llm: new FakeLLM(`{"kind":"ambiguous","mechanismIds":["${searchId}","${travelId}"]}`), isLlmEnabled: () => true,
      });
      expect(ambiguous.status).toBe(200);
      const ambiguousBody = await ambiguous.json() as any;
      expect(ambiguousBody).toMatchObject({ status: "ambiguous", generation: view.generation, actions: [
        { choiceId: expect.any(String), label: "Read here" },
        { choiceId: expect.any(String), label: "Go to another area" },
      ] });
      const ambiguousText = JSON.stringify(ambiguousBody);
      for (const forbidden of ["mechanismId", "command", "@compiled", searchId, travelId, "state", "trace", "pcId"]) expect(ambiguousText).not.toContain(forbidden);
      const invalid = await playerRequest(built, "player-intents", request("invalid intent"), { llm: new FakeLLM("not JSON"), isLlmEnabled: () => true });
      expect(invalid.status).toBe(422);
      const modelError = await playerRequest(built, "player-intents", request("error intent"), { llm: new FakeLLM(new Error("offline")), isLlmEnabled: () => true });
      expect(modelError.status).toBe(503);
      expect(built.snapshots.read(built.sessionId)).toEqual(snapshotBefore);
      for (const response of [disabled, noMatch, ambiguous, invalid, modelError]) {
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("rechecks the registry generation after awaiting the model and fails closed if a player action committed", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-race-"));
    try {
      const built = await createDeliveredSession(root);
      const view = await playerView(built);
      const searchId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id;
      const changing: LLMLike = {
        chat: async () => {
          const action = await playerRequest(built, "player-actions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
            body: JSON.stringify({ choiceId: view.actions.find((action) => action.label === "Search here")!.choiceId, actionId: ACTION_ID, expectedGeneration: view.generation }),
          });
          expect(action.status).toBe(200);
          return `{"kind":"selected","mechanismId":"${searchId}"}`;
        },
      };
      const response = await playerRequest(built, "player-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: built.cookie },
        body: JSON.stringify({ input: "search", expectedGeneration: view.generation }),
      }, { llm: changing, isLlmEnabled: () => true });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "PLAYER_INTENT_CONFLICT" }, generation: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("authenticates snapshot-backed player facades before namespace inventory or hydration", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-preauth-"));
    try {
      const built = await createDeliveredSession(root);
      const storage = { careerRoot: join(root, "careers") };
      const model = new FakeLLM('{"kind":"no_match"}');
      const observe = (options: { tamper?: "header" | "body" | "session" | "hash"; corrupt?: boolean; mismatchAdmission?: boolean; allowHydration?: boolean; wrongNamespaceKind?: boolean } = {}) => {
        const touches = { namespace: 0, inventory: 0, snapshotRead: 0, catalog: 0, registry: 0, factory: 0, bodyPulls: 0, bodyCancelled: 0 };
        const snapshots = new Proxy(built.snapshots, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (["listHeaders", "listOccupiedSessionIds", "isOccupied"].includes(String(property))) touches.inventory++;
              if (["read", "readHeader"].includes(String(property))) touches.snapshotRead++;
              if (options.corrupt && property === "readHeader") {
                return { status: "refused" as const, code: "SNAPSHOT_CORRUPT" as const, message: "injected corrupt snapshot" };
              }
              const result = Reflect.apply(value, target, args);
              if (result && typeof result === "object" && (result as any).status === "ok") {
                if (options.tamper === "header" && property === "readHeader") {
                  return { ...(result as any), value: { ...(result as any).value, snapshotHash: "0".repeat(64) } };
                }
                if (property === "read" && options.tamper === "body") {
                  return { ...(result as any), value: {
                    ...(result as any).value,
                    timestamps: { ...(result as any).value.timestamps, lastActiveAt: (result as any).value.timestamps.lastActiveAt + 1 },
                  } };
                }
                if (property === "read" && options.tamper === "session") {
                  return { ...(result as any), value: { ...(result as any).value, sessionId: "018f14a2-c2be-7b73-b291-6e64eaf7869c" } };
                }
                if (property === "read" && options.tamper === "hash") {
                  return { ...(result as any), value: { ...(result as any).value, stateHash: "0".repeat(64) } };
                }
              }
              return result;
            };
          },
        }) as unknown as CompiledSessionSnapshotStore;
        const namespace = new SessionNamespaceCoordinator(join(storage.careerRoot, ".runtime-session-namespace"));
        const observedNamespace = new Proxy(namespace, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              touches.namespace++;
              const result = Reflect.apply(value, target, args);
              if (options.wrongNamespaceKind && property === "read" && result && typeof result === "object" && (result as any).state === "committed") {
                return { ...(result as any), kind: "ordinary" };
              }
              return result;
            };
          },
        }) as unknown as SessionNamespaceCoordinator;
        const catalog = new Proxy(built.catalog, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => { touches.catalog++; return Reflect.apply(value, target, args); };
          },
        }) as unknown as CompilerArtifactCatalog;
        const registry = new Map<string, any>();
        for (const method of ["get", "set", "has", "delete"] as const) {
          const original = registry[method].bind(registry);
          (registry as any)[method] = (...args: unknown[]) => { touches.registry++; return (original as any)(...args); };
        }
        const runtime: SessionRuntimeDependencies = {
          registry,
          sessionNamespace: observedNamespace,
          ...(options.mismatchAdmission ? {
            compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(join(storage.careerRoot, ".runtime-session-namespace", "foreign-admission-domain")),
          } : {}),
          ...(!options.allowHydration ? {
            createCompiledRecoverySession: (() => {
              touches.factory++;
              throw new Error("player intent authentication must precede hydration");
            }) as any,
          } : {}),
        };
        const request = async (
          id: string,
          headers: Record<string, string>,
          route: "player-intents" | "player-view" | "player-actions" = "player-intents",
        ) => {
          const init: RequestInit = route === "player-view"
            ? { headers }
            : {
              method: "POST",
              headers: { "Content-Type": "application/json", Origin: "https://example.test", ...headers },
              body: new ReadableStream<Uint8Array>({
                pull(controller) {
                  touches.bodyPulls++;
                  controller.enqueue(new TextEncoder().encode(route === "player-actions"
                    ? '{"choiceId":"opaque-choice","actionId":"018f14a2-c2be-7b73-b291-6e64eaf7868f","expectedGeneration":0}'
                    : '{"input":"search","expectedGeneration":0}'));
                  controller.close();
                },
                cancel() { touches.bodyCancelled++; },
              }, { highWaterMark: 0 }),
            };
          const response = await handleRequest(new Request(`https://example.test/api/sessions/${id}/${route}`, init), catalog, snapshots, storage, { llm: model, isLlmEnabled: () => true }, {}, built.authenticator,
          undefined, undefined, built.delivery, undefined, runtime);
          return { response, body: await response.json() };
        };
        return { touches, request };
      };

      const known = observe();
      const deniedKnown = await known.request(built.sessionId, {});
      expect(deniedKnown.response.status).toBe(401);
      expect(deniedKnown.response.headers.get("cache-control")).toBe("no-store");
      expect(deniedKnown.body).toEqual({ error: { stage: "auth", code: "PLAYER_AUTH_REQUIRED", message: "player authentication is required" } });
      expect(known.touches).toEqual({ namespace: 0, inventory: 0, snapshotRead: expect.any(Number), catalog: 0, registry: 0, factory: 0, bodyPulls: 0, bodyCancelled: 0 });
      expect(known.touches.snapshotRead).toBeGreaterThan(0);

      const unknown = observe();
      const deniedUnknown = await unknown.request("018f14a2-c2be-7b73-b291-6e64eaf7869b", {});
      expect(deniedUnknown.response.status).toBe(401);
      expect(deniedUnknown.response.headers.get("cache-control")).toBe("no-store");
      expect(deniedUnknown.body).toEqual(deniedKnown.body);
      expect(unknown.touches).toEqual({ namespace: 0, inventory: 0, snapshotRead: expect.any(Number), catalog: 0, registry: 0, factory: 0, bodyPulls: 0, bodyCancelled: 0 });
      expect(unknown.touches.snapshotRead).toBeGreaterThan(0);

      for (const [credential, headers] of [
        ["missing", {}],
        ["invalid", { Cookie: "compiled_player_invalid=not-a-valid-cookie" }],
      ] as const) {
        for (const route of ["player-view", "player-actions"] as const) {
          const facade = observe();
          const denied = await facade.request(built.sessionId, headers, route);
          expect(denied.response.status, `${route}/${credential}`).toBe(401);
          expect(denied.response.headers.get("cache-control"), `${route}/${credential}`).toBe("no-store");
          expect(denied.body, `${route}/${credential}`).toEqual(deniedKnown.body);
          expect(facade.touches, `${route}/${credential}`).toEqual({
            namespace: 0,
            inventory: 0,
            snapshotRead: expect.any(Number),
            catalog: 0,
            registry: 0,
            factory: 0,
            bodyPulls: 0,
            bodyCancelled: 0,
          });
          expect(facade.touches.snapshotRead, `${route}/${credential}`).toBeGreaterThan(0);
        }
      }

      // `player-view` and `player-actions` must use the same opaque snapshot
      // gate as intents even when a caller presents a real cookie. A regression
      // that special-cases either route, skips full snapshot validation, or
      // cancels an unread upload must fail before namespace/hydration work.
      for (const route of ["player-view", "player-actions"] as const) {
        for (const [label, id, options] of [
          ["unknown", "018f14a2-c2be-7b73-b291-6e64eaf7869b", {}],
          ["corrupt", built.sessionId, { corrupt: true }],
          ["header", built.sessionId, { tamper: "header" as const }],
          ["body", built.sessionId, { tamper: "body" as const }],
          ["session", built.sessionId, { tamper: "session" as const }],
          ["hash", built.sessionId, { tamper: "hash" as const }],
        ] as const) {
          const facade = observe(options);
          const denied = await facade.request(id, { Cookie: built.cookie }, route);
          expect(denied.response.status, `${route}/${label}`).toBe(401);
          expect(denied.response.headers.get("cache-control"), `${route}/${label}`).toBe("no-store");
          expect(denied.body, `${route}/${label}`).toEqual(deniedKnown.body);
          expect(facade.touches, `${route}/${label}`).toEqual({
            namespace: 0,
            inventory: 0,
            snapshotRead: expect.any(Number),
            catalog: 0,
            registry: 0,
            factory: 0,
            bodyPulls: 0,
            bodyCancelled: 0,
          });
          expect(facade.touches.snapshotRead, `${route}/${label}`).toBeGreaterThan(0);
        }
      }

      const coldView = observe({ allowHydration: true });
      const acceptedColdView = await coldView.request(built.sessionId, { Cookie: built.cookie }, "player-view");
      expect(acceptedColdView.response.status).toBe(200);
      expect(acceptedColdView.body).toMatchObject({ generation: 0 });
      expect(coldView.touches.namespace).toBeGreaterThan(0);
      expect(coldView.touches.inventory).toBeGreaterThan(0);
      expect(coldView.touches.snapshotRead).toBeGreaterThan(0);
      expect(coldView.touches.catalog).toBeGreaterThan(0);
      expect(coldView.touches.registry).toBeGreaterThan(0);
      expect(coldView.touches.bodyPulls).toBe(0);
      expect(coldView.touches.bodyCancelled).toBe(0);

      const mismatch = observe({ mismatchAdmission: true });
      const mismatched = await mismatch.request(built.sessionId, { Cookie: built.cookie });
      expect(mismatched.response.status).toBe(503);
      expect(mismatched.response.headers.get("retry-after")).toBe("1");
      expect(mismatched.body).toEqual({ error: { stage: "persistence", code: "COMPILED_INTENT_ADMISSION_ROOT_MISMATCH", message: "compiled intent admission is unavailable" } });
      expect(mismatch.touches).toEqual({ namespace: 0, inventory: 0, snapshotRead: expect.any(Number), catalog: 0, registry: 0, factory: 0, bodyPulls: 0, bodyCancelled: 0 });

      for (const tamper of ["header", "body", "session", "hash"] as const) {
        const tampered = observe({ tamper });
        const deniedTamper = await tampered.request(built.sessionId, { Cookie: built.cookie });
        expect(deniedTamper.response.status, tamper).toBe(401);
        expect(deniedTamper.body, tamper).toEqual(deniedKnown.body);
        expect(tampered.touches, tamper).toEqual({ namespace: 0, inventory: 0, snapshotRead: expect.any(Number), catalog: 0, registry: 0, factory: 0, bodyPulls: 0, bodyCancelled: 0 });
      }

      const canonical = observe({ allowHydration: true });
      const accepted = await canonical.request(built.sessionId, { Cookie: built.cookie });
      expect(accepted.response.status).toBe(200);
      expect(accepted.body).toEqual({ status: "no_match", generation: 0 });
      expect(canonical.touches.namespace).toBeGreaterThan(0);
      expect(canonical.touches.inventory).toBeGreaterThan(0);
      expect(canonical.touches.snapshotRead).toBeGreaterThan(0);
      expect(canonical.touches.catalog).toBeGreaterThan(0);
      expect(canonical.touches.registry).toBeGreaterThan(0);
      expect(canonical.touches.bodyPulls).toBeGreaterThan(0);
      expect(canonical.touches.bodyCancelled).toBe(0);

      const wrongKind = observe({ wrongNamespaceKind: true });
      const opaqueWrongKind = await wrongKind.request(built.sessionId, { Cookie: built.cookie });
      expect(opaqueWrongKind.response.status).toBe(404);
      expect(opaqueWrongKind.response.headers.get("cache-control")).toBe("no-store");
      expect(opaqueWrongKind.body).toEqual({ error: "会话不存在或已过期" });
      expect(wrongKind.touches).toEqual({ namespace: expect.any(Number), inventory: expect.any(Number), snapshotRead: expect.any(Number), catalog: 0, registry: 0, factory: 0, bodyPulls: 0, bodyCancelled: 0 });
      expect(model.calls).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains Bearer owner and assigned-player access for legacy compiled facades without delivery grants", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-legacy-bearer-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = saveTrustedFixtureBundle(catalog, fixture);
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
      const authenticator = (request: Request) => {
        const token = request.headers.get("authorization");
        if (token === "Bearer legacy-owner") return { status: "authenticated" as const, principal: { role: "keeper" as const, id: "keeper:legacy-owner" } };
        if (token === "Bearer legacy-player") return { status: "authenticated" as const, principal: { role: "player" as const, id: "player:legacy-p1" } };
        if (token === "Bearer legacy-foreign") return { status: "authenticated" as const, principal: { role: "keeper" as const, id: "keeper:legacy-foreign" } };
        return { status: "unauthenticated" as const };
      };
      const delivery = createEnvironmentPlayerDelivery({});
      const created = await handleRequest(new Request("https://example.test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer legacy-owner" },
        body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Legacy bearer" }),
      }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticator, undefined,
      () => ({ status: "assigned" as const, principal: { role: "player" as const, id: "player:legacy-p1" } }), delivery);
      expect(created.status).toBe(201);
      const { sessionId } = await created.json() as { sessionId: string };
      const request = async (token: string, llm = new FakeLLM('{"kind":"no_match"}')) => {
        const response = await handleRequest(new Request(`https://example.test/api/sessions/${sessionId}/player-intents`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ input: "search", expectedGeneration: 0 }),
        }), catalog, snapshots, { careerRoot: join(root, "careers") }, { llm, isLlmEnabled: () => true }, {}, authenticator,
        undefined, undefined, delivery);
        return { response, llm };
      };

      // A valid but unbound Bearer must be refused before namespace/catalog/
      // registry/factory work for every snapshot-backed façade. Keep this
      // separate from the unauthenticated-token assertion below: 403 proves
      // the snapshot access binding, while an unknown token remains a 401.
      for (const route of ["player-view", "player-actions", "player-intents"] as const) {
        const touches = { namespace: 0, catalog: 0, registry: 0, factory: 0, bodyPulls: 0, bodyCancelled: 0 };
        const observedCatalog = new Proxy(catalog, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => { touches.catalog++; return Reflect.apply(value, target, args); };
          },
        }) as unknown as CompilerArtifactCatalog;
        const namespace = new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace"));
        const observedNamespace = new Proxy(namespace, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => { touches.namespace++; return Reflect.apply(value, target, args); };
          },
        }) as unknown as SessionNamespaceCoordinator;
        const registry = new Map<string, any>();
        for (const method of ["get", "set", "has", "delete"] as const) {
          const original = registry[method].bind(registry);
          (registry as any)[method] = (...args: unknown[]) => { touches.registry++; return (original as any)(...args); };
        }
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            touches.bodyPulls++;
            controller.enqueue(new TextEncoder().encode(route === "player-actions"
              ? '{"choiceId":"opaque-choice","actionId":"018f14a2-c2be-7b73-b291-6e64eaf7868f","expectedGeneration":0}'
              : '{"input":"search","expectedGeneration":0}'));
            controller.close();
          },
          cancel() { touches.bodyCancelled++; },
        }, { highWaterMark: 0 });
        const response = await handleRequest(new Request(`https://example.test/api/sessions/${sessionId}/${route}`, route === "player-view"
          ? { headers: { Authorization: "Bearer legacy-foreign" } }
          : { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.test", Authorization: "Bearer legacy-foreign" }, body }),
        observedCatalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticator,
        undefined, undefined, delivery, undefined, {
          registry,
          sessionNamespace: observedNamespace,
          createCompiledRecoverySession: (() => { touches.factory++; throw new Error("foreign Bearer must be refused before hydration"); }) as any,
        });
        expect(response.status, route).toBe(403);
        expect(response.headers.get("cache-control"), route).toBe("no-store");
        expect(await response.json(), route).toEqual({ error: {
          stage: "auth",
          code: "COMPILED_SESSION_ACCESS_DENIED",
          message: "authenticated principal is not permitted to access this compiled session",
        } });
        expect(touches, route).toEqual({ namespace: 0, catalog: 0, registry: 0, factory: 0, bodyPulls: 0, bodyCancelled: 0 });
      }
      for (const [index, token] of ["legacy-owner", "legacy-player"].entries()) {
        const accepted = await request(token);
        expect(accepted.response.status).toBe(200);
        expect(await accepted.response.json()).toEqual({ status: "no_match", generation: 0 });
        expect(accepted.llm.calls).toHaveLength(index === 0 ? 1 : 0);
      }
      const rejected = await request("wrong-principal");
      expect(rejected.response.status).toBe(401);
      expect(rejected.response.headers.get("cache-control")).toBe("no-store");
      expect(await rejected.response.json()).toEqual({ error: { stage: "auth", code: "PLAYER_AUTH_REQUIRED", message: "player authentication is required" } });
      expect(rejected.llm.calls).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not turn an unavailable player-delivery provider into a pre-auth locator oracle", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-intent-delivery-unavailable-"));
    try {
      const built = await createDeliveredSession(root);
      const unavailableDelivery = createEnvironmentPlayerDelivery({});
      const storage = { careerRoot: join(root, "careers") };
      const run = async (kind: "known" | "unknown" | "corrupt", cookie?: string) => {
        const touches = { namespace: 0, catalog: 0, factory: 0, registry: 0, body: 0, model: 0 };
        const snapshots = new Proxy(built.snapshots, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (kind === "corrupt" && property === "readHeader") {
                return { status: "refused" as const, code: "SNAPSHOT_CORRUPT" as const, message: "injected corrupt snapshot" };
              }
              return Reflect.apply(value, target, args);
            };
          },
        }) as unknown as CompiledSessionSnapshotStore;
        const namespace = new SessionNamespaceCoordinator(join(storage.careerRoot, ".runtime-session-namespace"));
        const observedNamespace = new Proxy(namespace, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => { touches.namespace++; return Reflect.apply(value, target, args); };
          },
        }) as unknown as SessionNamespaceCoordinator;
        const catalog = new Proxy(built.catalog, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => { touches.catalog++; return Reflect.apply(value, target, args); };
          },
        }) as unknown as CompilerArtifactCatalog;
        const registry = new Map<string, any>();
        for (const method of ["get", "set", "has", "delete"] as const) {
          const original = registry[method].bind(registry);
          (registry as any)[method] = (...args: unknown[]) => { touches.registry++; return (original as any)(...args); };
        }
        const llm: LLMLike = {
          async chat() { touches.model++; return '{"kind":"no_match"}'; },
        };
        const id = kind === "unknown" ? "018f14a2-c2be-7b73-b291-6e64eaf7869d" : built.sessionId;
        const response = await handleRequest(new Request(`https://example.test/api/sessions/${id}/player-intents`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://example.test", ...(cookie ? { Cookie: cookie } : {}) },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              touches.body++;
              controller.enqueue(new TextEncoder().encode('{"input":"search","expectedGeneration":0}'));
              controller.close();
            },
          }, { highWaterMark: 0 }),
        }), catalog, snapshots, storage, { llm, isLlmEnabled: () => true }, {}, built.authenticator,
        undefined, undefined, unavailableDelivery, undefined, {
          registry,
          sessionNamespace: observedNamespace,
          createCompiledRecoverySession: (() => { touches.factory++; throw new Error("must not hydrate before player authentication"); }) as any,
        });
        return { response, body: await response.json(), touches };
      };

      const attempts = [
        await run("known"),
        await run("known", `${built.cookie.slice(0, -1)}x`),
        await run("unknown"),
        await run("corrupt"),
      ];
      for (const attempt of attempts) {
        expect(attempt.response.status).toBe(401);
        expect(attempt.response.headers.get("cache-control")).toBe("no-store");
        expect(attempt.body).toEqual({ error: { stage: "auth", code: "PLAYER_AUTH_REQUIRED", message: "player authentication is required" } });
        expect(attempt.touches).toEqual({ namespace: 0, catalog: 0, factory: 0, registry: 0, body: 0, model: 0 });
      }
      expect(attempts.map((attempt) => attempt.body)).toEqual([attempts[0]!.body, attempts[0]!.body, attempts[0]!.body, attempts[0]!.body]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
