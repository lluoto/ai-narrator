import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import {
  ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  OrdinarySessionSnapshotStore,
  createOrdinaryArchivedActionReceipt,
  createOrdinarySessionEnvelope,
  ordinaryOperationRequestHash,
  ordinaryOperationSnapshotProjection,
} from "../api/ordinary-session-snapshot-store";
import { createOrdinaryGameSessionSnapshot, ORDINARY_GAME_SESSION_SNAPSHOT_VERSION } from "../api/ordinary-game-session-snapshot";

const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const auth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-luck-owner" } });

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

test("unsupported rulesets do not fabricate a Luck projection", () => {
  const session = new GameSession("ordinary-luck-no-default", "dnd5e", CONFIG, "fighter", "Ada");
  try {
    expect(session.getState().player).not.toHaveProperty("luck");
    expect(session.getCharacterSummary()).not.toHaveProperty("luck");
  } finally {
    session.close();
  }
});

test("ordinary /luck-spend commits a durable structured operation and exact replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-luck-durable-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { sessionId: string }).sessionId;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const before = snapshots.read(id);
    expect(before.status).toBe("ok");
    if (before.status !== "ok") throw new Error(before.message);
    const beforeLastActiveAt = before.value.snapshot.session.lastActiveAt;
    const committed = await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, {
      amount: 1, actionId: "ordinary-luck-spend-0001", expectedGeneration: 0,
    });
    expect(committed.status).toBe(200);
    const receipt = await committed.json() as { pcId: string; amount: number; previousLuck: number; luck: number; ordinaryGeneration: number };
    expect(receipt).toMatchObject({ pcId: "p1", amount: 1, ordinaryGeneration: 1 });
    expect(receipt.previousLuck - receipt.amount).toBe(receipt.luck);
    const afterCommit = snapshots.read(id);
    expect(afterCommit.status).toBe("ok");
    if (afterCommit.status !== "ok") throw new Error(afterCommit.message);
    const committedLastActiveAt = afterCommit.value.snapshot.session.lastActiveAt;
    expect(committedLastActiveAt).toBeGreaterThan(beforeLastActiveAt);
    const replay = await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, {
      amount: 1, actionId: "ordinary-luck-spend-0001", expectedGeneration: 0,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(await replay.json()).toEqual(receipt);
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1, snapshot: { session: { lastActiveAt: committedLastActiveAt } } } });
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary Luck is canonically projected on create, GET, action, spend, and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-luck-projection-"));
  const current = runtime();
  const restarted = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { sessionId: string; character?: { luck?: unknown } };
    const id = createdBody.sessionId;
    expect(createdBody.character?.luck).toSatisfy((luck) => Number.isSafeInteger(luck) && (luck as number) >= 0 && (luck as number) <= 99);
    const createdLuck = createdBody.character?.luck as number;

    const initial = await request(root, current.dependencies, `/api/sessions/${id}`);
    expect(initial.status).toBe(200);
    expect((await initial.json() as { state?: { player?: { luck?: unknown } } }).state?.player?.luck).toBe(createdLuck);

    const spent = await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, {
      amount: 1, actionId: "ordinary-luck-projection-spend-0001", expectedGeneration: 0,
    });
    expect(spent.status).toBe(200);
    const receipt = await spent.json() as { luck: number; previousLuck: number };
    expect(receipt.previousLuck).toBe(createdLuck);
    expect(receipt.luck).toBe(createdLuck - 1);

    const afterSpend = await request(root, current.dependencies, `/api/sessions/${id}`);
    expect(afterSpend.status).toBe(200);
    expect((await afterSpend.json() as { state?: { player?: { luck?: unknown } } }).state?.player?.luck).toBe(receipt.luck);

    const action = await request(root, current.dependencies, `/api/sessions/${id}/action`, {
      input: "/help", actionId: "ordinary-luck-projection-action-0001", expectedGeneration: 1,
    });
    expect(action.status).toBe(200);
    expect((await action.json() as { state?: { player?: { luck?: unknown } } }).state?.player?.luck).toBe(receipt.luck);

    // The current text-action receipt is a signed projection too: Luck must
    // stay bound to the active snapshot member even though this operation did
    // not itself spend Luck.
    const store = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const currentEnvelope = store.read(id);
    expect(currentEnvelope.status).toBe("ok");
    if (currentEnvelope.status !== "ok") throw new Error(currentEnvelope.message);
    const textRecord = currentEnvelope.value.idempotency.at(-1);
    if (!textRecord || textRecord.operation?.kind !== "text_action") throw new Error("current text receipt is required");
    const projection = ordinaryOperationSnapshotProjection(currentEnvelope.value.snapshot, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, textRecord.operation);
    expect(projection).toEqual(ordinaryOperationSnapshotProjection(currentEnvelope.value.snapshot, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION));
    if (!("party" in projection)) throw new Error("current operation projection is required");
    const active = projection.party.find((member) => member.pcId === projection.activePlayerId);
    if (!active || active.luck === null) throw new Error("active Luck projection is required");
    const receiptBase = {
      kind: "ordinary-action-receipt" as const,
      schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION as "1.5.0",
      sessionId: id,
      previousArchiveHash: currentEnvelope.value.archive.previousHeadHash,
      record: textRecord,
      projection,
    };
    expect(() => createOrdinaryArchivedActionReceipt(receiptBase)).not.toThrow();
    const changedLuck = structuredClone(textRecord) as unknown as { response: { state: { player: { luck?: number } } } };
    changedLuck.response.state.player.luck = active.luck === 0 ? 1 : active.luck - 1;
    expect(() => createOrdinaryArchivedActionReceipt({ ...receiptBase, record: changedLuck as never })).toThrow();
    const omittedLuck = structuredClone(textRecord) as unknown as { response: { state: { player: { luck?: number } } } };
    delete omittedLuck.response.state.player.luck;
    expect(() => createOrdinaryArchivedActionReceipt({ ...receiptBase, record: omittedLuck as never })).toThrow();

    const resumed = await request(root, restarted.dependencies, `/api/sessions/${id}`);
    expect(resumed.status).toBe(200);
    expect((await resumed.json() as { state?: { player?: { luck?: unknown } } }).state?.player?.luck).toBe(receipt.luck);
  } finally {
    for (const session of current.registry.values()) session.close();
    for (const session of restarted.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /luck-spend survives restart, detects stale and cross-kind action IDs, and deducts once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-luck-restart-"));
  const current = runtime();
  const restarted = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const baseline = snapshots.read(id);
    expect(baseline.status).toBe("ok");
    if (baseline.status !== "ok") throw new Error(baseline.message);
    const baselineLastActiveAt = baseline.value.snapshot.session.lastActiveAt;
    const operation = { amount: 2, actionId: "ordinary-luck-restart-0001", expectedGeneration: 0 };
    const committed = await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, operation);
    expect(committed.status).toBe(200);
    const receipt = await committed.json() as { luck: number; ordinaryGeneration: number };
    const afterCommit = snapshots.read(id);
    expect(afterCommit.status).toBe("ok");
    if (afterCommit.status !== "ok") throw new Error(afterCommit.message);
    if (typeof baselineLastActiveAt !== "number" || typeof afterCommit.value.snapshot.session.lastActiveAt !== "number") {
      throw new Error(`ordinary liveness timestamps are invalid: ${String(baselineLastActiveAt)} -> ${String(afterCommit.value.snapshot.session.lastActiveAt)}`);
    }
    expect(afterCommit.value.snapshot.session.lastActiveAt).toBeGreaterThan(baselineLastActiveAt);
    expect((await request(root, restarted.dependencies, `/api/sessions/${id}`)).status).toBe(200);
    const replay = await request(root, restarted.dependencies, `/api/sessions/${id}/luck-spend`, operation);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(await replay.json()).toEqual(receipt);
    expect(restarted.registry.get(id)?.exportOrdinarySessionSnapshot().state.characters.find((entry) => entry.pcId === "p1")?.sheet).toMatchObject({ luck: receipt.luck });
    const textConflict = await request(root, restarted.dependencies, `/api/sessions/${id}/action`, {
      input: "/help", actionId: operation.actionId, expectedGeneration: 0,
    });
    expect(textConflict.status).toBe(409);
    const partyConflict = await request(root, restarted.dependencies, `/api/sessions/${id}/party`, {
      name: "Bea", archetype: "detective", actionId: operation.actionId, expectedGeneration: 0,
    });
    expect(partyConflict.status).toBe(409);
    const stale = await request(root, restarted.dependencies, `/api/sessions/${id}/luck-spend`, {
      amount: 1, actionId: "ordinary-luck-stale-0001", expectedGeneration: 0,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "ordinary_generation_conflict", ordinaryGeneration: 1 });
  } finally {
    for (const session of current.registry.values()) session.close();
    for (const session of restarted.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /luck-spend rejects a closed request contract and business failures without state change", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-luck-contract-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const baseline = snapshots.read(id);
    expect(baseline.status).toBe("ok");
    if (baseline.status !== "ok") throw new Error(baseline.message);
    const baselineLastActiveAt = baseline.value.snapshot.session.lastActiveAt;
    const valid = { amount: 1, actionId: "ordinary-luck-contract-0001", expectedGeneration: 0 };
    for (const body of [
      { ...valid, extra: true }, { ...valid, amount: 0 }, { ...valid, amount: 1.5 },
      { amount: 1, expectedGeneration: 0 }, { amount: 1, actionId: valid.actionId },
    ]) {
      const refused = await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "ordinary_luck_spend_contract_required" });
      expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { snapshot: { session: { lastActiveAt: baselineLastActiveAt } } } });
    }
    const oversized = await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, { ...valid, padding: "x".repeat(9 * 1024) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "ordinary_luck_spend_contract_required" });
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0, snapshot: { session: { lastActiveAt: baselineLastActiveAt } } } });
    for (const amount of [100, Number.MAX_SAFE_INTEGER]) {
      const insufficient = await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, { ...valid, amount });
      expect(insufficient.status).toBe(400);
      expect(await insufficient.json()).toMatchObject({ code: "ordinary_luck_spend_rejected", ordinaryGeneration: 0 });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { snapshot: { session: { lastActiveAt: baselineLastActiveAt } } } });
    }
    expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /luck-spend persistence failure drops its candidate without deducting", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-luck-persist-fail-"));
  const current = runtime();
  let failSuccessor = false;
  current.dependencies.ordinarySnapshots = new OrdinarySessionSnapshotStore({
    root: join(root, "sessions", "ordinary-snapshots"),
    testHooks: { onPublicationStage(stage) { if (failSuccessor && stage === "dirty-persisted") throw new Error("injected luck successor failure"); } },
  });
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const beforeSnapshot = current.registry.get(id)?.exportOrdinarySessionSnapshot();
    const beforeCharacter = beforeSnapshot?.state.characters.find((entry) => entry.pcId === "p1");
    const before = beforeCharacter && typeof beforeCharacter.sheet === "object" && beforeCharacter.sheet !== null && !Array.isArray(beforeCharacter.sheet)
      ? beforeCharacter.sheet.luck : undefined;
    failSuccessor = true;
    const failed = await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, { amount: 1, actionId: "ordinary-luck-persist-fail-0001", expectedGeneration: 0 });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "ordinary_persistence_indeterminate", ordinaryGeneration: 0 });
    expect(current.dependencies.ordinarySnapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
    const afterSnapshot = current.registry.get(id)?.exportOrdinarySessionSnapshot();
    const afterCharacter = afterSnapshot?.state.characters.find((entry) => entry.pcId === "p1");
    const after = afterCharacter && typeof afterCharacter.sheet === "object" && afterCharacter.sheet !== null && !Array.isArray(afterCharacter.sheet)
      ? afterCharacter.sheet.luck : undefined;
    expect(after).toBe(before);
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /luck-spend keeps auth, remaining ordinary gates, and route shape ahead of body reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-luck-body-gate-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    const deniedBody = unreadJsonBody({ amount: 1, actionId: "ordinary-luck-auth-0001", expectedGeneration: 0 });
    const denied = await handleRequest(new Request(`http://test/api/sessions/${id}/luck-spend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: deniedBody.body }),
      undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, () => ({ status: "unauthenticated" }), undefined, undefined, undefined, { mode: "required" }, current.dependencies);
    expect(denied.status).toBe(401);
    expect(deniedBody.pulls()).toBe(0);
    for (const route of ["kp", "npc-chat"]) {
      const lockedBody = unreadJsonBody({ anything: "must not be parsed" });
      const locked = await handleRequest(new Request(`http://test/api/sessions/${id}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: lockedBody.body }),
        undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, current.dependencies);
      expect(locked.status).toBe(409);
      expect(lockedBody.pulls()).toBe(0);
    }
    const extraBody = unreadJsonBody({ amount: 1, actionId: "ordinary-luck-extra-0001", expectedGeneration: 0 });
    const extra = await handleRequest(new Request(`http://test/api/sessions/${id}/luck-spend/extra`, { method: "POST", headers: { "Content-Type": "application/json" }, body: extraBody.body }),
      undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, current.dependencies);
    expect(extra.status).toBe(404);
    expect(extraBody.pulls()).toBe(0);
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary /luck-spend receipt validators reject re-hashed active-authority, arithmetic, and snapshot Luck tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-luck-receipt-"));
  const current = runtime();
  try {
    const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    const id = (await created.json() as { sessionId: string }).sessionId;
    expect((await request(root, current.dependencies, `/api/sessions/${id}/luck-spend`, {
      amount: 1, actionId: "ordinary-luck-receipt-0001", expectedGeneration: 0,
    })).status).toBe(200);
    const store = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const read = store.read(id);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") throw new Error(read.message);
    const record = read.value.idempotency.at(-1);
    if (!record || record.operation?.kind !== "luck_spend") throw new Error("Luck receipt is required");
    const projection = ordinaryOperationSnapshotProjection(read.value.snapshot, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, record.operation);
    expect(projection).toEqual(ordinaryOperationSnapshotProjection(read.value.snapshot, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION));
    if (!("party" in projection)) throw new Error("current operation projection is required");
    const base = {
      kind: "ordinary-action-receipt" as const,
      schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION as "1.5.0",
      sessionId: id,
      previousArchiveHash: read.value.archive.previousHeadHash,
      record,
      projection,
    };
    expect(() => createOrdinaryArchivedActionReceipt(base)).not.toThrow();
    const tamperedOperation = structuredClone(record) as unknown as { actionId: string; expectedGeneration: number; requestHash: string; operation: { kind: "luck_spend"; amount: number } };
    tamperedOperation.operation.amount = 2;
    tamperedOperation.requestHash = ordinaryOperationRequestHash(id, tamperedOperation.actionId, tamperedOperation.operation, tamperedOperation.expectedGeneration);
    expect(() => createOrdinaryArchivedActionReceipt({ ...base, record: tamperedOperation as never })).toThrow();
    const pcIdTamper = structuredClone(record) as unknown as { response: Record<string, unknown> };
    pcIdTamper.response.pcId = "p2";
    expect(() => createOrdinaryArchivedActionReceipt({ ...base, record: pcIdTamper as never })).toThrow();
    const originalResponse = record.response as unknown as Record<string, unknown>;
    const previousLuckTamper = structuredClone(record) as unknown as { response: Record<string, unknown> };
    const originalPreviousLuck = originalResponse.previousLuck;
    if (typeof originalPreviousLuck !== "number") throw new Error("previous Luck is required");
    previousLuckTamper.response.previousLuck = originalPreviousLuck === 0 ? 1 : originalPreviousLuck - 1;
    expect(() => createOrdinaryArchivedActionReceipt({ ...base, record: previousLuckTamper as never })).toThrow();
    const luckTamper = structuredClone(record) as unknown as { response: Record<string, unknown> };
    const originalLuck = originalResponse.luck;
    if (typeof originalLuck !== "number") throw new Error("Luck is required");
    luckTamper.response.luck = originalLuck === 99 ? 98 : originalLuck + 1;
    expect(() => createOrdinaryArchivedActionReceipt({ ...base, record: luckTamper as never })).toThrow();
    const projectionTamper = structuredClone(projection);
    const active = projectionTamper.party.find((member) => member.pcId === projectionTamper.activePlayerId);
    if (!active || active.luck === null) throw new Error("active Luck projection is required");
    active.luck = active.luck === 0 ? 1 : active.luck - 1;
    expect(() => createOrdinaryArchivedActionReceipt({ ...base, projection: projectionTamper })).toThrow();
    const { snapshotHash: _oldHash, ...unsignedSnapshot } = structuredClone(read.value.snapshot);
    const activeCharacter = unsignedSnapshot.state.characters.find((entry) => entry.pcId === unsignedSnapshot.state.activePlayerId);
    if (!activeCharacter || typeof activeCharacter.sheet !== "object" || activeCharacter.sheet === null || Array.isArray(activeCharacter.sheet)) throw new Error("active sheet is required");
    activeCharacter.sheet.luck = 99;
    if (unsignedSnapshot.schemaVersion !== ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) throw new Error("current ordinary snapshot is required");
    const snapshotTamper = createOrdinaryGameSessionSnapshot(unsignedSnapshot);
    expect(() => createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: read.value.generation, previousEnvelopeHash: read.value.previousEnvelopeHash,
      access: read.value.access, snapshot: snapshotTamper, idempotency: read.value.idempotency,
      archive: read.value.archive, replayDirectory: read.value.replayDirectory,
    })).toThrow();
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
