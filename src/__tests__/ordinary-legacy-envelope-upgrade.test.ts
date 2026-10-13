import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash } from "../api/ordinary-game-session-snapshot";
import {
  ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  OrdinarySessionSnapshotStore,
  createOrdinarySessionEnvelope,
  nextOrdinarySessionArchive,
  ordinaryActionRequestHash,
  type OrdinaryPersistedActionRecord,
} from "../api/ordinary-session-snapshot-store";
import { OrdinaryActionAdmissionCoordinator } from "../api/ordinary-action-admission";
import { hydrateOrdinarySession, runOrdinaryActionTransaction } from "../api/server";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { CareerFileStore } from "../character/career-file";
import type { CareerEntry, CharacterSnapshot } from "../character/career";

function historicalV11(snapshot: any): any {
  const value = structuredClone(snapshot);
  value.schemaVersion = "1.1.0";
  value.components.snapshot = "1.1.0";
  value.state.woundsTreated = false;
  delete value.state.woundsTreatedByPC;
  delete value.state.terminal;
  delete value.components.career;
  delete value.career;
  const { snapshotHash: _discarded, ...unsigned } = value;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function legacyV10(snapshot: any): any {
  const value = historicalV11(snapshot);
  value.schemaVersion = "1.0.0";
  value.components.snapshot = "1.0.0";
  delete value.state.skillGrowthMarksByPC;
  value.state.skillGrowthMarks = [];
  const { snapshotHash: _discarded, ...unsigned } = value;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function existingEntry(): CareerEntry {
  return {
    id: "legacy-target-entry",
    characterName: "Ada",
    moduleId: "target-local-history",
    moduleName: "Target Local History",
    completedAt: "2026-09-30T00:00:00.000Z",
    endingId: "completed",
    endingName: "Completed",
    sanChange: 0,
    cmChange: 0,
    reputationChange: 0,
    skillChanges: [],
    rewardIds: [],
    narrative: "history that a legacy snapshot cannot replace",
  };
}

function store(root: string): OrdinarySessionSnapshotStore {
  return new OrdinarySessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
}

function options(
  root: string,
  snapshots: OrdinarySessionSnapshotStore,
  registry: Map<string, GameSession>,
  ordinaryDurableHostCapability: object,
) {
  return {
    snapshots,
    sessionRegistry: registry,
    storage: { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    intentPolicy: "development_fallback" as const,
    // The snapshot store creates this durable root before an action can be
    // admitted; the admission database is intentionally shared by retries.
    actionAdmission: new OrdinaryActionAdmissionCoordinator(snapshots.root),
    ordinaryDurableHostCapability,
  };
}

/**
 * The server owns this opaque capability.  The fixture only receives it
 * through the real hydration constructor seam and passes that exact value
 * back into the durable transaction; it never creates or substitutes one.
 */
function hydrateWithServerInjectedCapability(
  id: string,
  snapshots: OrdinarySessionSnapshotStore,
  storage: { careerRoot?: string; sessionRoot?: string },
) {
  let ordinaryDurableHostCapability: object | undefined;
  const hydrated = hydrateOrdinarySession(id, {
    snapshots,
    storage,
    intentPolicy: "development_fallback",
    createSession: (sessionId, access, runtimeDependencies) => {
      ordinaryDurableHostCapability = runtimeDependencies.ordinaryDurableHostCapability;
      return new GameSession(sessionId, "cosmic-horror", undefined, undefined, undefined, undefined,
        storage, access, "development_fallback", runtimeDependencies);
    },
  });
  return {
    hydrated,
    ordinaryDurableHostCapability: () => {
      if (!ordinaryDurableHostCapability) throw new Error("legacy fixture did not receive the server-minted durable host capability");
      return ordinaryDurableHostCapability;
    },
  };
}

async function makeHistoricalGenerationOne(root: string, snapshots: OrdinarySessionSnapshotStore, id: string) {
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "legacy-envelope-owner" });
  const source = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source-careers") }, access, "development_fallback");
  const initialSnapshot = historicalV11(source.exportOrdinarySessionSnapshot());
  const initial = createOrdinarySessionEnvelope({
    kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
    sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: initialSnapshot, idempotency: [],
  });
  expect(snapshots.save(initial)).toMatchObject({ status: "ok" });

  const acted = await source.act("/help");
  expect(acted.error).toBeUndefined();
  const snapshot = historicalV11(source.exportOrdinarySessionSnapshot());
  const record: OrdinaryPersistedActionRecord = {
    actionId: "legacy-envelope-old-action-0001",
    input: "/help",
    pcId: null,
    expectedGeneration: 0,
    generation: 1,
    status: 200,
    requestHash: ordinaryActionRequestHash(id, "legacy-envelope-old-action-0001", "/help", null, 0),
    response: JSON.parse(JSON.stringify({ ...acted, summary: source.getSummary(), sessionKind: "ordinary", ordinaryGeneration: 1 })),
  };
  const archive = nextOrdinarySessionArchive(id, initial.archive, record, snapshot);
  const replayDirectory = snapshots.prepareOrdinaryReplayDirectory(id, initial.replayDirectory, record, archive.headHash!);
  const successor = createOrdinarySessionEnvelope({
    kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
    sessionId: id, generation: 1, previousEnvelopeHash: initial.envelopeHash, access, snapshot,
    idempotency: [record], archive, replayDirectory,
  });
  expect(snapshots.save(successor)).toMatchObject({ status: "ok" });
  source.close();
  return { access, initial, successor };
}

test("current outer envelope retains authenticated legacy g0 wire until an action upgrades it to complete Career", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-legacy-envelope-g0-"));
  const id = "ordinary_legacy_envelope_g0";
  const snapshots = store(root);
  const registry = new Map<string, GameSession>();
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "legacy-envelope-owner" });
  const source = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source-careers") }, access, "development_fallback");
  try {
    const historical = historicalV11(source.exportOrdinarySessionSnapshot());
    const envelope = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: historical, idempotency: [],
    });
    expect(snapshots.save(envelope)).toMatchObject({ status: "ok" });
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { envelopeHash: envelope.envelopeHash, snapshot: { schemaVersion: "1.1.0" } } });

    const actualCareer = new CareerFileStore(join(root, "careers", id));
    const base = source.careerStore?.getSnapshot("Ada");
    if (!base) throw new Error("source Ada base is required");
    actualCareer.saveSnapshot(structuredClone(base) as unknown as CharacterSnapshot);
    actualCareer.addEntry(existingEntry());
    const hydration = hydrateWithServerInjectedCapability(id, snapshots, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") });
    const hydrated = hydration.hydrated;
    expect(hydrated.status).toBe("ok");
    if (hydrated.status !== "ok") throw new Error(hydrated.message);
    registry.set(id, hydrated.session);

    const committed = await runOrdinaryActionTransaction(hydrated.session, {
      input: "/help", actionId: "legacy-envelope-upgrade-action-0002", expectedGeneration: 0,
    }, options(root, snapshots, registry, hydration.ordinaryDurableHostCapability()));
    expect(committed.status).toBe(200);
    const upgraded = snapshots.read(id);
    expect(upgraded).toMatchObject({ status: "ok", value: { generation: 1, previousEnvelopeHash: envelope.envelopeHash, snapshot: { schemaVersion: "1.4.0", career: { mode: "complete" } } } });
    expect(actualCareer.getEntries("Ada").map((entry) => entry.id)).toEqual(["legacy-target-entry"]);

    const duplicate = await runOrdinaryActionTransaction(registry.get(id)!, {
      input: "/help", actionId: "legacy-envelope-upgrade-action-0002", expectedGeneration: 0,
    }, options(root, snapshots, registry, hydration.ordinaryDurableHostCapability()));
    expect(duplicate).toMatchObject({ status: 200, headers: { "X-Ordinary-Action-Disposition": "duplicate" } });
  } finally {
    source.close();
    for (const session of registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical g1 envelope authenticates archive/replay, upgrades on a successor, replays old action, and restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-legacy-envelope-g1-"));
  const id = "ordinary_legacy_envelope_g1";
  const snapshots = store(root);
  const registry = new Map<string, GameSession>();
  try {
    const legacy = await makeHistoricalGenerationOne(root, snapshots, id);
    expect(snapshots.audit(id)).toMatchObject({ status: "ok", value: { generation: 1, envelopeHash: legacy.successor.envelopeHash, snapshot: { schemaVersion: "1.1.0" } } });
    const hydration = hydrateWithServerInjectedCapability(id, snapshots, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") });
    const hydrated = hydration.hydrated;
    expect(hydrated.status).toBe("ok");
    if (hydrated.status !== "ok") throw new Error(hydrated.message);
    registry.set(id, hydrated.session);

    const upgraded = await runOrdinaryActionTransaction(hydrated.session, {
      input: "/help", actionId: "legacy-envelope-new-action-0002", expectedGeneration: 1,
    }, options(root, snapshots, registry, hydration.ordinaryDurableHostCapability()));
    expect(upgraded.status).toBe(200);
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 2, previousEnvelopeHash: legacy.successor.envelopeHash, snapshot: { schemaVersion: "1.4.0", career: { mode: "complete" } } } });

    const oldDuplicate = await runOrdinaryActionTransaction(registry.get(id)!, {
      input: "/help", actionId: "legacy-envelope-old-action-0001", expectedGeneration: 0,
    }, options(root, snapshots, registry, hydration.ordinaryDurableHostCapability()));
    expect(oldDuplicate).toMatchObject({ status: 200, headers: { "X-Ordinary-Action-Disposition": "duplicate" } });

    for (const session of registry.values()) session.close();
    registry.clear();
    const restart = hydrateWithServerInjectedCapability(id, store(root), { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") });
    const restarted = restart.hydrated;
    expect(restarted).toMatchObject({ status: "ok", envelope: { generation: 2, snapshot: { schemaVersion: "1.4.0", career: { mode: "complete" } } } });
    if (restarted.status === "ok") restarted.session.close();
  } finally {
    for (const session of registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two hydrated legacy predecessors race under admission/CAS and publish exactly one complete successor", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-legacy-envelope-race-"));
  const id = "ordinary_legacy_envelope_race";
  const snapshots = store(root);
  const leftRegistry = new Map<string, GameSession>();
  const rightRegistry = new Map<string, GameSession>();
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "legacy-envelope-owner" });
  const source = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source-careers") }, access, "development_fallback");
  try {
    const snapshot = historicalV11(source.exportOrdinarySessionSnapshot());
    const envelope = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot, idempotency: [],
    });
    expect(snapshots.save(envelope)).toMatchObject({ status: "ok" });
    const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
    const leftHydration = hydrateWithServerInjectedCapability(id, snapshots, storage);
    const rightHydration = hydrateWithServerInjectedCapability(id, snapshots, storage);
    const left = leftHydration.hydrated;
    const right = rightHydration.hydrated;
    expect(left.status).toBe("ok");
    expect(right.status).toBe("ok");
    if (left.status !== "ok" || right.status !== "ok") throw new Error("both race candidates must hydrate");
    leftRegistry.set(id, left.session);
    rightRegistry.set(id, right.session);

    const [first, second] = await Promise.all([
      runOrdinaryActionTransaction(left.session, { input: "/help", actionId: "legacy-race-action-0001", expectedGeneration: 0 }, options(root, snapshots, leftRegistry, leftHydration.ordinaryDurableHostCapability())),
      runOrdinaryActionTransaction(right.session, { input: "/help", actionId: "legacy-race-action-0002", expectedGeneration: 0 }, options(root, snapshots, rightRegistry, rightHydration.ordinaryDurableHostCapability())),
    ]);
    expect([first.status, second.status].filter((status) => status === 200)).toHaveLength(1);
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1, previousEnvelopeHash: envelope.envelopeHash, snapshot: { schemaVersion: "1.4.0", career: { mode: "complete" } } } });
  } finally {
    source.close();
    for (const session of leftRegistry.values()) session.close();
    for (const session of rightRegistry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("current v1.4 outer accepts a verified v1.0 nested g0 wire and refuses a failed upgrade without a half migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-legacy-envelope-v10-failure-"));
  const id = "ordinary_legacy_envelope_v10";
  let failSuccessor = false;
  const snapshots = new OrdinarySessionSnapshotStore({
    root: join(root, "snapshots"),
    allowUncoordinatedTestWrites: true,
    testHooks: { onPublicationStage(stage) { if (failSuccessor && stage === "dirty-persisted") throw new Error("injected successor publication failure"); } },
  });
  const registry = new Map<string, GameSession>();
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "legacy-envelope-owner" });
  const source = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source-careers") }, access, "development_fallback");
  try {
    const historical = legacyV10(source.exportOrdinarySessionSnapshot());
    const envelope = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: historical, idempotency: [],
    });
    expect(snapshots.save(envelope)).toMatchObject({ status: "ok" });
    const hydration = hydrateWithServerInjectedCapability(id, snapshots, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") });
    const hydrated = hydration.hydrated;
    expect(hydrated.status).toBe("ok");
    if (hydrated.status !== "ok") throw new Error(hydrated.message);
    registry.set(id, hydrated.session);

    failSuccessor = true;
    const failed = await runOrdinaryActionTransaction(hydrated.session, {
      input: "/help", actionId: "legacy-envelope-v10-failed-upgrade-0001", expectedGeneration: 0,
    }, options(root, snapshots, registry, hydration.ordinaryDurableHostCapability()));
    expect(failed.status).not.toBe(200);
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0, envelopeHash: envelope.envelopeHash, snapshot: { schemaVersion: "1.0.0" } } });
  } finally {
    source.close();
    for (const session of registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
