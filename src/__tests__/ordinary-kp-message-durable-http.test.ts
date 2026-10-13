import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { GameSession, appendOrdinaryHostAnnouncement } from "../api/game-session";
import {
  ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  OrdinarySessionSnapshotStore,
  createOrdinaryArchivedActionReceipt,
  createOrdinarySessionEnvelope,
  ordinaryOperationSnapshotProjection,
} from "../api/ordinary-session-snapshot-store";
import { handleRequest, parseOrdinaryKpMessageRequest, type SessionRuntimeDependencies } from "../api/server";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";

const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const auth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-kp-owner" } });

function runtime(): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  return {
    registry,
    dependencies: {
      registry,
      ordinaryIntentPolicy: "development_fallback",
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "opening";
        return session;
      },
    },
  };
}

async function request(root: string, dependencies: SessionRuntimeDependencies, path: string, body?: unknown): Promise<Response> {
  return handleRequest(new Request(`http://test${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
  undefined, undefined, undefined, { mode: "required" }, dependencies);
}

function unreadJsonBody(value: unknown): { body: ReadableStream<Uint8Array>; pulls: () => number } {
  let pulls = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }, { highWaterMark: 0 }),
    pulls: () => pulls,
  };
}

async function rawRequest(root: string, dependencies: SessionRuntimeDependencies, id: string, suffix: string, body: ReadableStream<Uint8Array>): Promise<Response> {
  return handleRequest(new Request(`http://test/api/sessions/${id}/${suffix}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
  undefined, undefined, undefined, { mode: "required" }, dependencies);
}

test("ordinary host KP announcement is a durable, exact-replay receipt across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-kp-message-durable-"));
  const current = runtime();
  const restarted = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { sessionId: string }).sessionId;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const before = snapshots.read(id);
    expect(before).toMatchObject({ status: "ok", value: { generation: 0 } });

    const input = {
      actionId: "ordinary-kp-message-0001",
      expectedGeneration: 0,
      message: "  钟楼的钟声在雾中响起。  ",
    };
    const committed = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, input);
    expect(committed.status).toBe(200);
    const receipt = await committed.json() as {
      message: { speaker: string; content: string; type: "system" | "narration"; timestamp: number };
      summary: { id: string; messageCount: number };
      sessionKind: string;
      ordinaryGeneration: number;
    };
    expect(receipt).toMatchObject({
      message: { speaker: "守秘人", content: "钟楼的钟声在雾中响起。", type: "system" },
      summary: { id, messageCount: 1 }, sessionKind: "ordinary", ordinaryGeneration: 1,
    });
    expect(Number.isSafeInteger(receipt.message.timestamp)).toBe(true);

    const committedEnvelope = snapshots.read(id);
    expect(committedEnvelope.status).toBe("ok");
    if (committedEnvelope.status !== "ok") throw new Error(committedEnvelope.message);
    expect(committedEnvelope.value).toMatchObject({ generation: 1, idempotency: [{ actionId: input.actionId, operation: { kind: "kp_message" } }] });
    const snapshot = committedEnvelope.value.snapshot;
    expect(snapshot.playerSession.globalMessages.at(-1)).toEqual(receipt.message);
    for (const player of snapshot.playerSession.players) expect(player.messageHistory.at(-1)).toEqual(receipt.message);
    const committedLastActiveAt = snapshot.session.lastActiveAt;
    const record = committedEnvelope.value.idempotency.at(-1);
    if (!record || record.operation?.kind !== "kp_message") throw new Error("KP receipt is required");
    const projection = ordinaryOperationSnapshotProjection(snapshot, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, record.operation);
    expect(() => createOrdinaryArchivedActionReceipt({
      kind: "ordinary-action-receipt", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: id,
      previousArchiveHash: committedEnvelope.value.archive.previousHeadHash, record, projection,
    })).not.toThrow();
    const missingBinding = structuredClone(projection) as unknown as Record<string, unknown>;
    delete missingBinding.kpMessage;
    expect(() => createOrdinaryArchivedActionReceipt({
      kind: "ordinary-action-receipt", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: id,
      previousArchiveHash: committedEnvelope.value.archive.previousHeadHash, record, projection: missingBinding as never,
    })).toThrow();
    const alteredResponse = structuredClone(committedEnvelope.value) as any;
    alteredResponse.idempotency.at(-1).response.message.content = "forged";
    delete alteredResponse.envelopeHash;
    expect(() => createOrdinarySessionEnvelope(alteredResponse)).toThrow("KP message response does not match its snapshot");

    expect((await request(root, restarted.dependencies, `/api/sessions/${id}`)).status).toBe(200);
    const replay = await request(root, restarted.dependencies, `/api/sessions/${id}/kp/send-message`, input);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(await replay.json()).toEqual(receipt);
    const replayedEnvelope = snapshots.read(id);
    expect(replayedEnvelope).toMatchObject({ status: "ok", value: { generation: 1, snapshot: { session: { lastActiveAt: committedLastActiveAt } } } });
    if (replayedEnvelope.status === "ok") {
      expect(replayedEnvelope.value.snapshot.playerSession.globalMessages.filter((entry) => entry.content === receipt.message.content)).toHaveLength(1);
    }
    // A later ordinary action makes the KP receipt historic. Its replay still
    // has to validate the archived, snapshot-bound message rather than infer
    // it from the newer live global-message tail.
    const later = await request(root, restarted.dependencies, `/api/sessions/${id}/action`, {
      actionId: "ordinary-kp-later-action-0002", expectedGeneration: 1, input: "/help",
    });
    expect(later.status).toBe(200);
    const afterLater = snapshots.read(id);
    expect(afterLater).toMatchObject({ status: "ok", value: { generation: 2 } });
    const historicReplay = await request(root, restarted.dependencies, `/api/sessions/${id}/kp/send-message`, input);
    expect(historicReplay.status).toBe(200);
    expect(historicReplay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(await historicReplay.json()).toEqual(receipt);
    const afterHistoricReplay = snapshots.read(id);
    expect(afterHistoricReplay).toMatchObject({ status: "ok", value: { generation: 2 } });
    if (afterHistoricReplay.status === "ok") {
      expect(afterHistoricReplay.value.snapshot.playerSession.globalMessages.filter((entry) => entry.content === receipt.message.content)).toHaveLength(1);
    }
  } finally {
    for (const session of current.registry.values()) session.close();
    for (const session of restarted.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary KP message parser normalizes only its closed host operation and rejects source/target pollution", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-kp-message-contract-"));
  const current = runtime();
  try {
    const parsed = parseOrdinaryKpMessageRequest({
      actionId: "ordinary-kp-parser-0001", expectedGeneration: 0, message: "  announce  ", speaker: "  Keeper  ", type: " narration ",
    });
    expect(parsed).toEqual({
      actionId: "ordinary-kp-parser-0001", expectedGeneration: 0,
      operation: { kind: "kp_message", content: "announce", speaker: "Keeper", type: "narration" },
    });
    const accessor = { actionId: "ordinary-kp-parser-0002", expectedGeneration: 0, message: "announce" } as Record<string, unknown>;
    Object.defineProperty(accessor, "message", { enumerable: true, get: () => "announce" });
    expect(parseOrdinaryKpMessageRequest(accessor)).toBeNull();
    expect(parseOrdinaryKpMessageRequest(Object.assign(Object.create({ message: "announce" }), { actionId: "ordinary-kp-parser-0003", expectedGeneration: 0 }))).toBeNull();
    const symbolCarrier = { actionId: "ordinary-kp-parser-0004", expectedGeneration: 0, message: "announce", [Symbol("side-channel")]: true };
    expect(parseOrdinaryKpMessageRequest(symbolCarrier)).toBeNull();
    // Own `undefined` is not omission. A direct caller must not gain a
    // defaulted field through a JSON-only assumption at this trusted seam.
    expect(parseOrdinaryKpMessageRequest({ actionId: "ordinary-kp-parser-0005", expectedGeneration: 0, message: "announce", speaker: undefined })).toBeNull();
    expect(parseOrdinaryKpMessageRequest({ actionId: "ordinary-kp-parser-0006", expectedGeneration: 0, message: "announce", type: undefined })).toBeNull();

    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const store = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const beforeFailure = store.read(id);
    const beforeFailureLastActiveAt = beforeFailure.status === "ok" ? beforeFailure.value.snapshot.session.lastActiveAt : undefined;
    for (const body of [
      { actionId: "ordinary-kp-invalid-0001", expectedGeneration: 0, message: "announce", source: "forbidden" },
      { actionId: "ordinary-kp-invalid-0002", expectedGeneration: 0, message: "announce", target: "p1" },
      { actionId: "ordinary-kp-invalid-0003", expectedGeneration: 0, message: "announce", type: "dialogue" },
      { actionId: "ordinary-kp-invalid-0004", expectedGeneration: 0, message: "   " },
      { expectedGeneration: 0, message: "announce" },
    ]) {
      const refused = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, body);
      expect(refused.status).toBe(400);
    }
    const oversize = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, {
      actionId: "ordinary-kp-invalid-0005", expectedGeneration: 0, message: "x".repeat(8 * 1024),
    });
    expect(oversize.status).toBe(413);
    expect(store.read(id)).toMatchObject({ status: "ok", value: { generation: 0, snapshot: { session: { lastActiveAt: beforeFailureLastActiveAt } } } });

    const first = { actionId: "ordinary-kp-contract-0001", expectedGeneration: 0, message: "  first announcement  ", speaker: "  Keeper  ", type: " narration " };
    const committed = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, first);
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ message: { speaker: "Keeper", content: "first announcement", type: "narration" }, ordinaryGeneration: 1 });
    const changedReplay = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, { ...first, message: "a different message" });
    expect(changedReplay.status).toBe(409);
    const stale = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, {
      actionId: "ordinary-kp-contract-0002", expectedGeneration: 0, message: "stale",
    });
    expect(stale.status).toBe(409);
    expect(store.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("KP message binds every current player tail and does not contaminate other operation projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-kp-message-party-binding-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const party = await request(root, current.dependencies, `/api/sessions/${id}/party`, {
      actionId: "ordinary-kp-party-0001", expectedGeneration: 0, name: "Bea", archetype: "detective",
    });
    expect(party.status).toBe(201);
    const store = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const partyEnvelope = store.read(id);
    expect(partyEnvelope.status).toBe("ok");
    if (partyEnvelope.status !== "ok") throw new Error(partyEnvelope.message);
    const partyRecord = partyEnvelope.value.idempotency.at(-1);
    if (!partyRecord?.operation || partyRecord.operation.kind !== "party_member_create") throw new Error("party receipt is required");
    expect(ordinaryOperationSnapshotProjection(partyEnvelope.value.snapshot, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, partyRecord.operation)).not.toHaveProperty("kpMessage");

    const committed = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, {
      actionId: "ordinary-kp-party-0002", expectedGeneration: 1, message: "all investigators hear this",
    });
    expect(committed.status).toBe(200);
    const receipt = await committed.json() as { message: { speaker: string; content: string; type: "system" | "narration"; timestamp: number } };
    const messageEnvelope = store.read(id);
    expect(messageEnvelope.status).toBe("ok");
    if (messageEnvelope.status !== "ok") throw new Error(messageEnvelope.message);
    expect(messageEnvelope.value.snapshot.playerSession.players).toHaveLength(2);
    expect(messageEnvelope.value.snapshot.playerSession.globalMessages.at(-1)).toEqual(receipt.message);
    for (const player of messageEnvelope.value.snapshot.playerSession.players) expect(player.messageHistory.at(-1)).toEqual(receipt.message);
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary retires direct KP/NPC mutations before body reads without changing the durable session", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-kp-message-gates-"));
  const current = runtime();
  const compiledRegistry = new Map<string, GameSession>();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const source = current.registry.get(id);
    if (!source) throw new Error("ordinary source is required");
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const before = snapshots.read(id);
    if (before.status !== "ok") throw new Error(before.message);
    const beforeHistory = source.getHistory();
    for (const route of ["kp/set-san", "kp/set-hp", "kp/apply-damage", "kp/set-scene", "kp/set-difficulty", "npc-chat"]) {
      const body = unreadJsonBody({ must: "not be read" });
      const refused = await rawRequest(root, current.dependencies, id, route, body.body);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "ordinary_mutation_not_durable" });
      expect(body.pulls()).toBe(0);
    }
    for (const route of ["kp/unknown", "kp/send-message/extra"]) {
      const body = unreadJsonBody({ must: "not be read" });
      const refused = await rawRequest(root, current.dependencies, id, route, body.body);
      expect(refused.status).toBe(404);
      expect(body.pulls()).toBe(0);
    }
    expect(source.getHistory()).toEqual(beforeHistory);
    expect(snapshots.read(id)).toEqual(before);

    const fixture = await compiledModuleHttpFixture("ordinary-kp-message-compiled-gate");
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const compiledSnapshots = new CompiledSessionSnapshotStore({ root: join(root, "sessions", "compiled-snapshots") });
    const compiledCreated = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, compiledSnapshots, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
    undefined, undefined, undefined, { mode: "required" }, { registry: compiledRegistry });
    expect(compiledCreated.status).toBe(201);
    const compiledId = (await compiledCreated.json() as { sessionId: string }).sessionId;
    const compiledBefore = compiledSnapshots.read(compiledId);
    if (compiledBefore.status !== "ok") throw new Error(compiledBefore.message);
    const compiledSource = compiledRegistry.get(compiledId);
    if (!compiledSource) throw new Error("compiled source is required");
    const compiledHistoryBefore = compiledSource.getHistory();
    const model = { calls: 0, async chat() { this.calls++; throw new Error("retired route must not invoke LLM"); } };
    for (const route of ["kp/send-message", "kp/set-san", "kp/unknown", "kp/send-message/extra", "character", "party", "npc-chat", "luck-spend"]) {
      const compiledBody = unreadJsonBody({ actionId: "ordinary-kp-compiled-0001", expectedGeneration: 0, message: "must not be read" });
      const compiled = await handleRequest(new Request(`http://test/api/sessions/${compiledId}/${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: compiledBody.body,
      }), catalog, compiledSnapshots, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, { llm: model, isLlmEnabled: () => true }, {}, auth,
      undefined, undefined, undefined, { mode: "required" }, { registry: compiledRegistry });
      expect(compiled.status).toBe(409);
      expect(await compiled.json()).toMatchObject({ code: "compiled_mutation_unsupported" });
      expect(compiledBody.pulls()).toBe(0);
    }
    expect(model.calls).toBe(0);
    expect(compiledSource.getHistory()).toEqual(compiledHistoryBefore);
    expect(compiledSnapshots.read(compiledId)).toEqual(compiledBefore);
  } finally {
    for (const session of current.registry.values()) session.close();
    for (const session of compiledRegistry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary KP durable candidate ignores shadowed public sendMessage and addMessage dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-kp-message-private-authority-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const source = current.registry.get(id);
    if (!source) throw new Error("server source is required");
    const beforeDirect = source.getHistory().messages;
    expect(() => appendOrdinaryHostAnnouncement(source, Object.freeze({}), "Keeper", "bypass", "system"))
      .toThrow("requires the durable host capability");
    expect(source.getHistory().messages).toEqual(beforeDirect);
    const originalFactory = current.dependencies.createOrdinarySession!;
    current.dependencies.createOrdinarySession = (input) => {
      const candidate = originalFactory(input);
      Object.defineProperties(candidate, {
        sendMessage: { configurable: true, value: () => false },
        addMessage: { configurable: true, value: () => { throw new Error("forged public addMessage"); } },
      });
      return candidate;
    };
    const committed = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, {
      actionId: "ordinary-kp-private-0001", expectedGeneration: 0, message: "private authority persists this",
    });
    expect(committed.status).toBe(200);
    const body = await committed.json() as { message: { content: string }; ordinaryGeneration: number };
    expect(body).toMatchObject({ message: { content: "private authority persists this" }, ordinaryGeneration: 1 });
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("KP announcement seam requires an unforgeable host capability and closes runtime values", () => {
  const capability = Object.freeze(Object.create(null)) as object;
  const session = new GameSession(
    `ordinary-kp-capability-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    "detective",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: capability },
  );
  try {
    const before = session.getHistory().messages;
    expect(() => appendOrdinaryHostAnnouncement(session, Object.freeze({}), "Keeper", "forged", "system"))
      .toThrow("requires the durable host capability");
    expect(() => appendOrdinaryHostAnnouncement(session, capability, " Keeper ", "forged", "system"))
      .toThrow("values are invalid");
    expect(() => appendOrdinaryHostAnnouncement(session, capability, "Keeper", "forged", "dialogue"))
      .toThrow("values are invalid");
    expect(() => appendOrdinaryHostAnnouncement(session, capability, "Keeper", "x".repeat(8_001), "system"))
      .toThrow("values are invalid");
    expect(session.getHistory().messages).toEqual(before);
    expect(appendOrdinaryHostAnnouncement(session, capability, "Keeper", "canonical", "narration"))
      .toMatchObject({ speaker: "Keeper", content: "canonical", type: "narration" });
  } finally {
    session.close();
  }
});

test("a host factory that drops the private capability cannot publish or replace the ordinary source", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-kp-message-capability-drop-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const source = current.registry.get(id);
    if (!source) throw new Error("ordinary source is required");
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const before = snapshots.read(id);
    if (before.status !== "ok") throw new Error(before.message);
    current.dependencies.createOrdinarySession = ({
      id: targetId, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy,
    }) => {
      // Deliberately discard the required host constructor dependency. The
      // server must reject this candidate before a durable operation runs.
      const target = new GameSession(targetId, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy);
      target.getOpeningScene = async () => "opening";
      return target;
    };

    const refused = await request(root, current.dependencies, `/api/sessions/${id}/kp/send-message`, {
      actionId: "ordinary-kp-capability-drop-0001", expectedGeneration: 0, message: "must remain uncommitted",
    });
    expect(refused.status).toBe(500);
    expect(current.registry.get(id)).toBe(source);
    expect(snapshots.read(id)).toMatchObject({
      status: "ok",
      value: { generation: 0, snapshot: { session: { lastActiveAt: before.value.snapshot.session.lastActiveAt } } },
    });
    expect(source.getHistory().messages).toHaveLength(0);
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
