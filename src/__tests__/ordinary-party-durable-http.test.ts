import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { CareerFileStore } from "../character/career-file";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { createOrdinaryGameSessionSnapshot, type OrdinaryGameSessionSnapshot } from "../api/ordinary-game-session-snapshot";
import {
  LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  OrdinarySessionSnapshotStore,
  createOrdinaryArchivedActionReceipt,
  createOrdinarySessionEnvelope,
  ordinaryActionRequestHash,
  ordinaryActionSnapshotProjection,
  ordinaryOperationSnapshotProjection,
} from "../api/ordinary-session-snapshot-store";
import { OrdinaryActionAdmissionCoordinator } from "../api/ordinary-action-admission";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { cleanupExpiredSessions, hydrateOrdinarySession, runOrdinaryActionTransaction } from "../api/server";

const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const auth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-party-owner" } });

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
  }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, dependencies);
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

function withLastActiveAt(snapshot: OrdinaryGameSessionSnapshot, lastActiveAt: number): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = structuredClone(snapshot);
  return createOrdinaryGameSessionSnapshot({
    ...unsigned,
    session: { ...unsigned.session, createdAt: Math.min(unsigned.session.createdAt, lastActiveAt), lastActiveAt },
  });
}

test("ordinary /party is a durable, exact-replayable structured operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-durable-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { sessionId: string }).sessionId;
    const operation = {
      name: "Bea",
      archetype: "detective",
      personality: "careful",
      actionId: "ordinary-party-create-0001",
      expectedGeneration: 0,
    };

    const committed = await request(root, current.dependencies, `/api/sessions/${id}/party`, operation);
    expect(committed.status).toBe(201);
    const receipt = await committed.json() as { pcId: string; ordinaryGeneration: number; sessionKind: string };
    expect(receipt).toMatchObject({ name: "Bea", archetype: "detective", ordinaryGeneration: 1, sessionKind: "ordinary" });
    const committedSession = current.registry.get(id);
    expect(committedSession?.exportOrdinarySessionSnapshot().state.party.map((member) => member.pcId)).toContain(receipt.pcId);
    expect(new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") }).read(id)).toMatchObject({
      status: "ok", value: { generation: 1, idempotency: [{ status: 201, operation: { kind: "party_member_create" } }] },
    });

    const duplicate = await request(root, current.dependencies, `/api/sessions/${id}/party`, operation);
    expect(duplicate.status).toBe(201);
    expect(duplicate.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(await duplicate.json()).toEqual(await (new Response(JSON.stringify(receipt))).json());
    expect(current.registry.get(id)?.exportOrdinarySessionSnapshot().state.party).toHaveLength(2);

    const payloadConflict = await request(root, current.dependencies, `/api/sessions/${id}/party`, { ...operation, name: "Cia" });
    expect(payloadConflict).toHaveProperty("status", 409);
    expect(await payloadConflict.json()).toMatchObject({ code: "ordinary_action_id_conflict", ordinaryGeneration: 1 });
    const kindConflict = await request(root, current.dependencies, `/api/sessions/${id}/action`, {
      input: "/help", actionId: operation.actionId, expectedGeneration: 0,
    });
    expect(kindConflict).toHaveProperty("status", 409);
    expect(await kindConflict.json()).toMatchObject({ code: "ordinary_action_id_conflict", ordinaryGeneration: 1 });
    const stale = await request(root, current.dependencies, `/api/sessions/${id}/party`, {
      ...operation, actionId: "ordinary-party-stale-0001", expectedGeneration: 0,
    });
    expect(stale).toHaveProperty("status", 409);
    expect(await stale.json()).toMatchObject({ code: "ordinary_generation_conflict", ordinaryGeneration: 1 });

    const restarted = runtime();
    expect((await request(root, restarted.dependencies, `/api/sessions/${id}`)).status).toBe(200);
    const restoredSession = restarted.registry.get(id);
    const restored = restoredSession?.exportOrdinarySessionSnapshot();
    expect(restored?.state).toMatchObject({ activePlayerId: "p1", activeCharacterId: "p1" });
    expect(restored?.state.party.map((member) => member.pcId).sort()).toEqual(["p1", receipt.pcId].sort());
    expect(restored?.state.characters.map((member) => member.pcId)).toContain(receipt.pcId);
    expect(restoredSession?.session.get(receipt.pcId)).toMatchObject({ name: receipt.pcId, characterId: receipt.pcId, characterName: "Bea" });
    expect(restoredSession?.session.getActive()).toMatchObject({ name: "p1", characterId: "p1" });
    expect(restoredSession?.world.getPlayerIds().sort()).toEqual(["p1", receipt.pcId].sort());
    expect(restoredSession?.world.getPlayerState("p1")).toBeDefined();
    expect(restoredSession?.world.getPlayerState(receipt.pcId)).toBeDefined();
    for (const session of restarted.registry.values()) session.close();
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /party rejects business-invalid candidates without changing the live generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-reject-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const refused = await request(root, current.dependencies, `/api/sessions/${id}/party`, {
      name: "Bea", archetype: "not-an-archetype", actionId: "ordinary-party-reject-0001", expectedGeneration: 0,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "ordinary_party_member_rejected", ordinaryGeneration: 0 });
    expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
    expect(current.registry.get(id)?.exportOrdinarySessionSnapshot().state.party.map((member) => member.pcId)).toEqual(["p1"]);
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /party rejects a duplicate Career character name before candidate persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-duplicate-name-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { sessionId: string }).sessionId;
    const liveBefore = current.registry.get(id)?.exportOrdinarySessionSnapshot();
    const persistedBefore = current.dependencies.ordinarySnapshots?.read(id);
    const realCareers = new CareerFileStore(join(root, "careers", id));
    const careerBefore = realCareers.exportPortableProjection();

    const refused = await request(root, current.dependencies, `/api/sessions/${id}/party`, {
      name: "Ada", archetype: "detective", actionId: "ordinary-party-duplicate-name-0001", expectedGeneration: 0,
    });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      code: "ordinary_party_member_rejected",
      reason: "duplicate_character_name",
      ordinaryGeneration: 0,
    });
    expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
    expect(current.registry.get(id)?.exportOrdinarySessionSnapshot()).toEqual(liveBefore);
    expect(current.dependencies.ordinarySnapshots?.read(id)).toEqual(persistedBefore);
    expect(realCareers.exportPortableProjection()).toEqual(careerBefore);

    const restarted = runtime();
    try {
      expect((await request(root, restarted.dependencies, `/api/sessions/${id}`)).status).toBe(200);
      expect(restarted.registry.get(id)?.exportOrdinarySessionSnapshot()).toEqual(liveBefore);
      expect(new CareerFileStore(join(root, "careers", id)).exportPortableProjection()).toEqual(careerBefore);
    } finally {
      for (const session of restarted.registry.values()) session.close();
    }
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /party accepts only the closed structured-operation request contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-contract-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const valid = { name: "Bea", archetype: "detective", actionId: "ordinary-party-contract-0001", expectedGeneration: 0 };
    const invalid: unknown[] = [
      { ...valid, unknown: true },
      { ...valid, name: " " },
      { ...valid, archetype: "x".repeat(129) },
      { name: valid.name, archetype: valid.archetype, expectedGeneration: 0 },
      { name: valid.name, archetype: valid.archetype, actionId: valid.actionId },
    ];
    for (const body of invalid) {
      const refused = await request(root, current.dependencies, `/api/sessions/${id}/party`, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "ordinary_party_contract_required" });
      expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
      expect(current.registry.get(id)?.exportOrdinarySessionSnapshot().state.party.map((member) => member.pcId)).toEqual(["p1"]);
    }
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /party persistence failure drops the candidate and leaves the live source unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-persist-fail-"));
  const current = runtime();
  let failSuccessor = false;
  current.dependencies.ordinarySnapshots = new OrdinarySessionSnapshotStore({
    root: join(root, "sessions", "ordinary-snapshots"),
    testHooks: { onPublicationStage(stage) { if (failSuccessor && stage === "dirty-persisted") throw new Error("injected party successor failure"); } },
  });
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    failSuccessor = true;
    const failed = await request(root, current.dependencies, `/api/sessions/${id}/party`, {
      name: "Bea", archetype: "detective", actionId: "ordinary-party-persist-fail-0001", expectedGeneration: 0,
    });
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Retry-After")).toBe("1");
    expect(await failed.json()).toMatchObject({ code: "ordinary_persistence_indeterminate", ordinaryGeneration: 0 });
    expect(current.dependencies.ordinarySnapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
    expect(current.registry.get(id)?.exportOrdinarySessionSnapshot().state.party.map((member) => member.pcId)).toEqual(["p1"]);
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /party commits idle liveness in its signed successor without changing it on failure or replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-last-active-"));
  const current = runtime();
  const id = "11111111-1111-4111-8111-111111111111";
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-party-owner" });
  const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
  const snapshots = new OrdinarySessionSnapshotStore({ root: join(storage.sessionRoot, "ordinary-snapshots"), allowUncoordinatedTestWrites: true });
  const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined, storage, access, "development_fallback");
  try {
    const oldLastActiveAt = Date.now() - 120_000;
    const initial = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 0, previousEnvelopeHash: null, access,
      snapshot: withLastActiveAt(source.exportOrdinarySessionSnapshot(), oldLastActiveAt), idempotency: [],
    });
    expect(snapshots.save(initial)).toMatchObject({ status: "ok" });
    source.close();
    const hydrated = hydrateOrdinarySession(id, { snapshots, storage, intentPolicy: "development_fallback" });
    expect(hydrated.status).toBe("ok");
    if (hydrated.status !== "ok") throw new Error(hydrated.message);
    current.registry.set(id, hydrated.session);
    current.dependencies.ordinarySnapshots = snapshots;

    const rejected = await request(root, current.dependencies, `/api/sessions/${id}/party`, {
      name: "Bea", archetype: "not-an-archetype", actionId: "ordinary-party-last-active-reject-0001", expectedGeneration: 0,
    });
    expect(rejected.status).toBe(400);
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0, snapshot: { session: { lastActiveAt: oldLastActiveAt } } } });
    expect(current.registry.get(id)?.lastActiveAt).toBe(oldLastActiveAt);

    const operation = { name: "Bea", archetype: "detective", actionId: "ordinary-party-last-active-0001", expectedGeneration: 0 };
    const committed = await request(root, current.dependencies, `/api/sessions/${id}/party`, operation);
    expect(committed.status).toBe(201);
    const receipt = await committed.json();
    const afterCommit = snapshots.read(id);
    expect(afterCommit.status).toBe("ok");
    if (afterCommit.status !== "ok") throw new Error(afterCommit.message);
    const committedLastActiveAt = afterCommit.value.snapshot.session.lastActiveAt;
    expect(committedLastActiveAt).toBeGreaterThan(oldLastActiveAt);
    expect(current.registry.get(id)?.lastActiveAt).toBe(committedLastActiveAt);
    const halfway = Math.floor((oldLastActiveAt + committedLastActiveAt) / 2);
    expect(cleanupExpiredSessions(current.registry, {
      now: committedLastActiveAt + 1, timeoutMs: committedLastActiveAt + 1 - halfway,
      deleteMetadata() { throw new Error("new durable party successor must not be evicted"); },
      isDurableOrdinary: () => true,
    })).toEqual([]);

    const replay = await request(root, current.dependencies, `/api/sessions/${id}/party`, operation);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(receipt);
    expect(snapshots.read(id)).toMatchObject({
      status: "ok", value: { generation: 1, snapshot: { session: { lastActiveAt: committedLastActiveAt }, state: { party: [{ pcId: "p1" }, { pcId: "p2" }] } } },
    });
  } finally {
    source.close();
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /party keeps authorization and the still-locked mutator gates ahead of body reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-body-gate-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const deniedBody = unreadJsonBody({ name: "Bea", archetype: "detective", actionId: "ordinary-party-auth-0001", expectedGeneration: 0 });
    const denied = await handleRequest(new Request(`http://test/api/sessions/${id}/party`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: deniedBody.body,
    }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {},
    () => ({ status: "unauthenticated" }), undefined, undefined, undefined, { mode: "required" }, current.dependencies);
    expect(denied.status).toBe(401);
    expect(deniedBody.pulls()).toBe(0);

    for (const route of ["kp", "npc-chat"]) {
      const lockedBody = unreadJsonBody({ anything: "must not be parsed" });
      const locked = await handleRequest(new Request(`http://test/api/sessions/${id}/${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: lockedBody.body,
      }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
      undefined, undefined, undefined, { mode: "required" }, current.dependencies);
      expect(locked.status).toBe(409);
      expect(lockedBody.pulls()).toBe(0);
    }
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /party only matches its exact route shape without consuming an extra-path body", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-route-shape-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const payload = { name: "Bea", archetype: "detective", actionId: "ordinary-party-extra-path-0001", expectedGeneration: 0 };
    const unauthenticatedBody = unreadJsonBody(payload);
    const unauthenticated = await handleRequest(new Request(`http://test/api/sessions/${id}/party/extra`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: unauthenticatedBody.body,
    }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {},
    () => ({ status: "unauthenticated" }), undefined, undefined, undefined, { mode: "required" }, current.dependencies);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticatedBody.pulls()).toBe(0);

    const extraPathBody = unreadJsonBody(payload);
    const extraPath = await handleRequest(new Request(`http://test/api/sessions/${id}/party/extra`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: extraPathBody.body,
    }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
    undefined, undefined, undefined, { mode: "required" }, current.dependencies);
    expect(extraPath.status).toBe(404);
    expect(extraPathBody.pulls()).toBe(0);
    expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a true 1.4 hot text receipt remains exact-replayable after structured-operation upgrade", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-legacy-text-replay-"));
  const id = "ordinary_party_legacy_text_replay";
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-party-owner" });
  const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
  const registry = new Map<string, GameSession>();
  const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
  const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined, storage, access, "development_fallback");
  try {
    const initial = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: source.exportOrdinarySessionSnapshot(), idempotency: [],
    });
    expect(snapshots.save(initial)).toMatchObject({ status: "ok" });
    const acted = await source.act("/help");
    const snapshot = source.exportOrdinarySessionSnapshot();
    const record = {
      actionId: "ordinary-party-legacy-text-0001", requestHash: ordinaryActionRequestHash(id, "ordinary-party-legacy-text-0001", "/help", null, 0),
      input: "/help", pcId: null, expectedGeneration: 0, generation: 1, status: 200 as const,
      response: JSON.parse(JSON.stringify({ ...acted, summary: source.getSummary(), sessionKind: "ordinary", ordinaryGeneration: 1 })),
    };
    const activeCharacter = snapshot.state.characters.find((entry) => entry.pcId === snapshot.state.activePlayerId);
    const canonicalLuck = (activeCharacter?.sheet as { luck?: unknown } | undefined)?.luck;
    const responseLuck = (record.response as { state?: { player?: { luck?: unknown } } }).state?.player?.luck;
    expect(typeof canonicalLuck).toBe("number");
    // The real 1.4-shaped receipt preserves the response produced at the
    // time, including the later public Luck display field.  Its hot envelope
    // still has the full snapshot that authorizes this display value.
    expect(responseLuck).toBe(canonicalLuck);
    const archived = createOrdinaryArchivedActionReceipt({
      kind: "ordinary-action-receipt", schemaVersion: LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, previousArchiveHash: null, record, projection: ordinaryActionSnapshotProjection(snapshot),
    });
    const archive = { count: 1, headHash: archived.archiveHash, previousHeadHash: null };
    const replayDirectory = snapshots.prepareOrdinaryReplayDirectory(id, initial.replayDirectory, record, archived.archiveHash);
    const tamperedHotRecord = structuredClone(record) as typeof record & { response: { state: { player: { luck: number } } } };
    tamperedHotRecord.response.state.player.luck = canonicalLuck === 0 ? 1 : 0;
    // Re-hashing the outer envelope cannot turn the current 1.4 receipt into
    // a different authoritative Luck value: the co-signed snapshot is the
    // source of truth before this receipt becomes a historical archive.
    expect(() => createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 1, previousEnvelopeHash: initial.envelopeHash, access, snapshot,
      idempotency: [tamperedHotRecord], archive, replayDirectory,
    })).toThrow("ordinary persisted legacy action Luck does not match its snapshot");
    const legacy = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 1, previousEnvelopeHash: initial.envelopeHash, access, snapshot, idempotency: [record], archive, replayDirectory,
    });
    expect(snapshots.save(legacy)).toMatchObject({ status: "ok" });
    source.close();
    let hydratedHostCapability: object | undefined;
    const hydrated = hydrateOrdinarySession(id, {
      snapshots, storage, intentPolicy: "development_fallback",
      createSession: (sessionId, recoveredAccess, runtimeDependencies) => {
        hydratedHostCapability = runtimeDependencies.ordinaryDurableHostCapability;
        return new GameSession(sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, recoveredAccess, "development_fallback", runtimeDependencies);
      },
    });
    expect(hydrated.status).toBe("ok");
    if (hydrated.status !== "ok") throw new Error(hydrated.message);
    registry.set(id, hydrated.session);
    const replay = await runOrdinaryActionTransaction(hydrated.session, {
      input: "/help", actionId: record.actionId, expectedGeneration: 0,
    }, {
      snapshots, sessionRegistry: registry, storage, intentPolicy: "development_fallback",
      ordinaryDurableHostCapability: hydratedHostCapability!,
      actionAdmission: new OrdinaryActionAdmissionCoordinator(snapshots.root),
    });
    expect(replay.status).toBe(200);
    expect(replay.headers).toMatchObject({ "X-Ordinary-Action-Disposition": "duplicate" });
    expect(replay.body).toEqual(record.response);
  } finally {
    source.close();
    for (const session of registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt validators reject re-hashed schema and party-projection tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-party-receipt-schema-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const committed = await request(root, current.dependencies, `/api/sessions/${id}/party`, {
      name: "Bea", archetype: "detective", personality: "careful", actionId: "ordinary-party-receipt-0001", expectedGeneration: 0,
    });
    expect(committed.status).toBe(201);
    const envelopeResult = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") }).read(id);
    expect(envelopeResult.status).toBe("ok");
    if (envelopeResult.status !== "ok") throw new Error("committed ordinary envelope is required");
    const record = envelopeResult.value.idempotency.at(-1);
    if (!record || record.operation?.kind !== "party_member_create") throw new Error("party receipt is required");
    const projection = ordinaryOperationSnapshotProjection(envelopeResult.value.snapshot, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, record.operation);
    // Existing 1.5 archive preimages must remain byte-for-byte shape-stable:
    // the character-only extension is absent from every older operation.
    expect(projection).toEqual(ordinaryOperationSnapshotProjection(envelopeResult.value.snapshot, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION));
    if (!("party" in projection)) throw new Error("1.5 party projection is required");
    const base = {
      kind: "ordinary-action-receipt" as const,
      schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION as "1.5.0",
      sessionId: id,
      previousArchiveHash: envelopeResult.value.archive.previousHeadHash,
      record,
      projection,
    };
    expect(() => createOrdinaryArchivedActionReceipt(base)).not.toThrow();

    // `create...` re-computes the archive hash before its hostile-input
    // validator runs: these are re-hashed attempts, not stale-hash failures.
    expect(() => createOrdinaryArchivedActionReceipt({
      ...base,
      schemaVersion: LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION as "1.4.0",
      projection: ordinaryActionSnapshotProjection(envelopeResult.value.snapshot),
    })).toThrow();
    const missingOperation = structuredClone(record) as unknown as Record<string, unknown>;
    delete missingOperation.operation;
    expect(() => createOrdinaryArchivedActionReceipt({ ...base, record: missingOperation as never })).toThrow();

    const responsePcIdTamper = structuredClone(record) as { response: Record<string, unknown> };
    responsePcIdTamper.response.pcId = "p1";
    expect(() => createOrdinaryArchivedActionReceipt({ ...base, record: responsePcIdTamper as never })).toThrow();
    const projectionPartyTamper = structuredClone(projection);
    const projected = projectionPartyTamper.party.find((member) => member.pcId === (record.response as unknown as Record<string, unknown>).pcId);
    if (!projected) throw new Error("projected party member is required");
    projected.name = "tampered";
    expect(() => createOrdinaryArchivedActionReceipt({ ...base, projection: projectionPartyTamper })).toThrow();
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
