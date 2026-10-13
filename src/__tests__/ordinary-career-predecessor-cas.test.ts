import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession, acknowledgeOrdinaryDurableIdentity } from "../api/game-session";
import { handleRequest, hydrateOrdinarySession, type SessionRuntimeDependencies } from "../api/server";
import { createOrdinaryGameSessionSnapshot, validateOrdinaryGameSessionSnapshot } from "../api/ordinary-game-session-snapshot";
import { createOrdinarySessionEnvelope, OrdinarySessionSnapshotStore, type OrdinarySessionEnvelope } from "../api/ordinary-session-snapshot-store";
import { OrdinaryActionAdmissionCoordinator } from "../api/ordinary-action-admission";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import {
  CareerFileStore,
  CareerProjectionPredecessorConflict,
  careerPortableProjectionHash,
  type CareerPortableProjection,
  type CareerPortableProjectionIdentity,
} from "../character/career-file";

const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const auth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-career-cas-owner" } });

function runtime(extra: Omit<Partial<SessionRuntimeDependencies>, "registry" | "createOrdinarySession"> = {}): {
  registry: Map<string, GameSession>;
  dependencies: SessionRuntimeDependencies;
  durableHostCapability: () => object;
} {
  const registry = new Map<string, GameSession>();
  let durableHostCapability: object | undefined;
  return {
    registry,
    durableHostCapability: () => {
      if (!durableHostCapability) throw new Error("ordinary test factory was not given the durable host capability");
      return durableHostCapability;
    },
    dependencies: {
      ...extra,
      registry,
      ordinaryIntentPolicy: "development_fallback",
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        durableHostCapability = runtimeDependencies?.ordinaryDurableHostCapability;
        const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "opening";
        return session;
      },
    },
  };
}

function restoreTarget(
  id: string,
  access: NonNullable<ConstructorParameters<typeof GameSession>[7]>,
  storage: { careerRoot?: string; sessionRoot?: string },
  runtimeDependencies?: { ordinaryDurableHostCapability: object },
): GameSession {
  const session = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, access, "development_fallback", runtimeDependencies);
  session.getOpeningScene = async () => "opening";
  return session;
}

async function request(root: string, dependencies: SessionRuntimeDependencies, path: string, body?: unknown): Promise<Response> {
  return handleRequest(
    new Request(`http://test${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, dependencies,
  );
}

async function createFixture(root: string, dependencies: SessionRuntimeDependencies): Promise<{
  sessionId: string;
  snapshots: OrdinarySessionSnapshotStore;
  envelope: OrdinarySessionEnvelope;
  projection: CareerPortableProjection;
}> {
  const created = await request(root, dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
  expect(created.status).toBe(201);
  const { sessionId } = await created.json() as { sessionId: string };
  const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
  const read = snapshots.read(sessionId);
  if (read.status !== "ok") throw new Error("ordinary fixture envelope is unavailable");
  const snapshot = validateOrdinaryGameSessionSnapshot(read.value.snapshot);
  if (snapshot.career.mode !== "complete") throw new Error("ordinary fixture lacks a complete Career projection");
  return { sessionId, snapshots, envelope: read.value, projection: snapshot.career.projection };
}

function projectionWithSan(projection: CareerPortableProjection, san: number): CareerPortableProjection {
  const next = structuredClone(projection);
  const base = next.records[0]?.base;
  if (!base) throw new Error("fixture Career projection lacks a base character");
  base.san = san;
  return next;
}

test("an A-to-B-to-A stage ABA rejects a stale predecessor before ordinary CAS", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-predecessor-cas-"));
  const first = runtime();
  const careerRoot = join(root, "careers");
  const prototype = CareerFileStore.prototype as unknown as {
    prepareOrdinaryProjectionCommit: (input: any, successor: unknown) => void;
  };
  const originalPrepare = prototype.prepareOrdinaryProjectionCommit;
  let armed = false;
  let injected = false;
  let originalIdentity: CareerPortableProjectionIdentity | undefined;
  let abaIdentity: CareerPortableProjectionIdentity | undefined;
  prototype.prepareOrdinaryProjectionCommit = function (this: CareerFileStore, input: any, successor: unknown): void {
    if (armed && !injected && (this as unknown as { baseDir?: unknown }).baseDir === join(careerRoot, input.sessionId)) {
      injected = true;
      const careers = new CareerFileStore(join(careerRoot, input.sessionId));
      const base = careers.getSnapshot("Ada");
      if (!base) throw new Error("fixture Career predecessor is unavailable");
      originalIdentity = careers.capturePortableProjectionIdentity();
      careers.saveSnapshot({ ...base, san: 17 });
      careers.saveSnapshot(base);
      abaIdentity = careers.capturePortableProjectionIdentity();
    }
    return originalPrepare.call(this, input, successor);
  };
  try {
    const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json() as { sessionId: string };

    armed = true;
    const action = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, {
      input: "调查", actionId: "ordinary-career-predecessor-0001", expectedGeneration: 0,
    });

    expect(action.status).toBe(409);
    expect(await action.json()).toMatchObject({ code: "ordinary_career_projection_conflict", ordinaryGeneration: 0 });
    expect(injected).toBe(true);
    expect(originalIdentity).toBeDefined();
    expect(abaIdentity).toBeDefined();
    if (!originalIdentity || !abaIdentity) throw new Error("fixture did not observe both Career identities");
    expect(abaIdentity.projectionHash).toBe(originalIdentity.projectionHash);
    expect(abaIdentity.version).not.toBe(originalIdentity.version);
    expect(new CareerFileStore(join(careerRoot, sessionId)).getSnapshot("Ada")?.san).toBeGreaterThan(17);
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    expect(snapshots.read(sessionId)).toMatchObject({ status: "ok", value: { generation: 0 } });
    // This action's stale CAS is refused, but A's content is again the exact
    // g0 projection. It is safe to recover a new g0 live object; the changed
    // stage UUID must not make a semantically identical current root unusable.
    expect(first.registry.get(sessionId)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
    expect((await request(root, first.dependencies, `/api/sessions/${sessionId}`)).status).toBe(200);
    expect(new CareerFileStore(join(careerRoot, sessionId)).capturePortableProjectionIdentity()).toEqual(abaIdentity);
  } finally {
    armed = false;
    prototype.prepareOrdinaryProjectionCommit = originalPrepare;
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a durable envelope recovers predecessor->successor on restart, then refuses a later third Career projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-postcommit-cas-"));
  const first = runtime();
  const recovering = runtime();
  const rejected = runtime();
  const careerRoot = join(root, "careers");
  const prototype = CareerFileStore.prototype as unknown as {
    resolveOrdinaryProjectionCommit: (input: any, authority: "successor" | "predecessor") => void;
    reconcileOrdinaryProjection: (input: any, successor: unknown) => void;
  };
  const originalResolve = prototype.resolveOrdinaryProjectionCommit;
  const originalReconcile = prototype.reconcileOrdinaryProjection;
  let holdPostCommitInstall = false;
  let holdImmediateRecovery = false;
  let targetCareerDirectory = "";
  const target = (store: CareerFileStore) => (store as unknown as { baseDir?: unknown }).baseDir === targetCareerDirectory;
  prototype.resolveOrdinaryProjectionCommit = function (this: CareerFileStore, input: any, authority: "successor" | "predecessor"): void {
    if (holdPostCommitInstall && authority === "successor" && target(this)) {
      throw new Error("injected post-CAS Career install failure");
    }
    return originalResolve.call(this, input, authority);
  };
  prototype.reconcileOrdinaryProjection = function (this: CareerFileStore, input: any, successor: unknown): void {
    if (holdImmediateRecovery && target(this)) throw new Error("injected immediate Career recovery failure");
    return originalReconcile.call(this, input, successor);
  };
  try {
    const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json() as { sessionId: string };
    targetCareerDirectory = join(careerRoot, sessionId);

    holdPostCommitInstall = true;
    holdImmediateRecovery = true;
    const actionId = "ordinary-career-postcommit-0001";
    const failedAfterCommit = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, {
      input: "调查", actionId, expectedGeneration: 0,
    });
    expect(failedAfterCommit.status).toBe(503);
    expect(await failedAfterCommit.json()).toMatchObject({ code: "ordinary_post_commit_recovery_required", ordinaryGeneration: 1 });
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    expect(snapshots.read(sessionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
    expect(snapshots.findActionReceipt(sessionId, actionId)).toMatchObject({ status: "ok", value: { actionId } });

    holdPostCommitInstall = false;
    holdImmediateRecovery = false;
    // The intent binds the exact pre-staged successor, so a fresh process can
    // install it from the durable envelope rather than replaying the action.
    const recovered = hydrateOrdinarySession(sessionId, {
      snapshots,
      storage: { careerRoot, sessionRoot: join(root, "sessions") },
      createSession: (id, access, runtimeDependencies) => restoreTarget(id, access, { careerRoot, sessionRoot: join(root, "sessions") }, runtimeDependencies),
    });
    expect(recovered.status).toBe("ok");
    if (recovered.status === "ok") recovering.registry.set(sessionId, recovered.session);
    const successorIdentity = new CareerFileStore(targetCareerDirectory).capturePortableProjectionIdentity();
    const idempotentRestart = runtime();
    try {
      const restarted = hydrateOrdinarySession(sessionId, {
        snapshots,
        storage: { careerRoot, sessionRoot: join(root, "sessions") },
        createSession: (id, access, runtimeDependencies) => restoreTarget(id, access, { careerRoot, sessionRoot: join(root, "sessions") }, runtimeDependencies),
      });
      expect(restarted.status).toBe("ok");
      if (restarted.status === "ok") { idempotentRestart.registry.set(sessionId, restarted.session); }
      expect(new CareerFileStore(targetCareerDirectory).capturePortableProjectionIdentity()).toEqual(successorIdentity);
    } finally {
      for (const session of idempotentRestart.registry.values()) session.close();
    }

    // The ordinary pointer is already durable. A subsequent conforming Career
    // writer creates a third stage; a later hydrate must fail closed instead
    // of restoring the envelope projection over that stage.
    const careers = new CareerFileStore(targetCareerDirectory);
    const base = careers.getSnapshot("Ada");
    if (!base) throw new Error("fixture Career successor is unavailable");
    careers.saveSnapshot({ ...base, san: 17 });
    expect((await request(root, rejected.dependencies, `/api/sessions/${sessionId}`)).status).not.toBe(200);
    expect(new CareerFileStore(targetCareerDirectory).getSnapshot("Ada")?.san).toBe(17);
  } finally {
    prototype.resolveOrdinaryProjectionCommit = originalResolve;
    prototype.reconcileOrdinaryProjection = originalReconcile;
    for (const runtimeValue of [first, recovering, rejected]) {
      for (const session of runtimeValue.registry.values()) session.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a successor active pointer with a retained journal is finalized idempotently on fresh restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-successor-journal-cas-"));
  const first = runtime();
  const careerRoot = join(root, "careers");
  const prototype = CareerFileStore.prototype as unknown as {
    deleteRootControlFile: (name: string) => void;
  };
  const originalDeleteControl = prototype.deleteRootControlFile;
  let failJournalDeletion = false;
  let targetCareerDirectory = "";
  prototype.deleteRootControlFile = function (this: CareerFileStore, name: string): void {
    if (failJournalDeletion && name === ".ordinary-career-projection-commit.json"
      && (this as unknown as { baseDir?: unknown }).baseDir === targetCareerDirectory) {
      throw new Error("injected journal finalization failure after successor activation");
    }
    return originalDeleteControl.call(this, name);
  };
  try {
    const fixture = await createFixture(root, first.dependencies);
    targetCareerDirectory = join(careerRoot, fixture.sessionId);
    failJournalDeletion = true;
    const response = await request(root, first.dependencies, `/api/sessions/${fixture.sessionId}/action`, {
      input: "调查", actionId: "ordinary-career-successor-journal-0001", expectedGeneration: 0,
    });
    expect(response.status).toBe(503);
    const successorEnvelope = fixture.snapshots.read(fixture.sessionId);
    expect(successorEnvelope).toMatchObject({ status: "ok", value: { generation: 1 } });
    if (successorEnvelope.status !== "ok") throw new Error("successor envelope is unavailable");
    const successorSnapshot = validateOrdinaryGameSessionSnapshot(successorEnvelope.value.snapshot);
    if (successorSnapshot.career.mode !== "complete") throw new Error("successor envelope lost Career projection");
    const careers = new CareerFileStore(targetCareerDirectory);
    expect(careerPortableProjectionHash(careers.exportPortableProjection())).toBe(careerPortableProjectionHash(successorSnapshot.career.projection));
    const pointerBefore = readFileSync(join(targetCareerDirectory, ".career-active.json"), "utf8");
    expect(existsSync(join(targetCareerDirectory, ".ordinary-career-projection-commit.json"))).toBe(true);

    failJournalDeletion = false;
    const freshNamespace = new SessionNamespaceCoordinator(join(root, "sessions"));
    const recovered = hydrateOrdinarySession(fixture.sessionId, {
      snapshots: fixture.snapshots,
      sessionNamespace: freshNamespace,
      storage: { careerRoot, sessionRoot: join(root, "sessions") },
      createSession: (id, access, runtimeDependencies) => restoreTarget(id, access, { careerRoot, sessionRoot: join(root, "sessions") }, runtimeDependencies),
    });
    expect(recovered.status).toBe("ok");
    if (recovered.status === "ok") recovered.session.close();
    expect(readFileSync(join(targetCareerDirectory, ".career-active.json"), "utf8")).toBe(pointerBefore);
    expect(existsSync(join(targetCareerDirectory, ".ordinary-career-projection-commit.json"))).toBe(false);
  } finally {
    failJournalDeletion = false;
    prototype.deleteRootControlFile = originalDeleteControl;
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a prepared predecessor orphan fences writers, then a fresh g0 hydrate cancels only that orphan", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-orphan-cas-"));
  const first = runtime();
  try {
    const fixture = await createFixture(root, first.dependencies);
    const careerDirectory = join(root, "careers", fixture.sessionId);
    const careers = new CareerFileStore(careerDirectory);
    const predecessor = careers.capturePortableProjectionIdentity();
    const successor = projectionWithSan(fixture.projection, 17);
    const intent = {
      sessionId: fixture.sessionId,
      predecessorGeneration: fixture.envelope.generation,
      predecessorEnvelopeHash: fixture.envelope.envelopeHash,
      generation: fixture.envelope.generation + 1,
      envelopeHash: "f".repeat(64),
      predecessor,
    };

    careers.prepareOrdinaryProjectionCommit(intent, successor);
    const base = careers.getSnapshot("Ada");
    if (!base) throw new Error("fixture Career predecessor is unavailable");
    expect(() => careers.saveSnapshot({ ...base, san: 17 })).toThrow(CareerProjectionPredecessorConflict);

    const recovered = hydrateOrdinarySession(fixture.sessionId, {
      snapshots: fixture.snapshots,
      storage: { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
      createSession: (id, access, runtimeDependencies) => restoreTarget(id, access, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, runtimeDependencies),
    });
    expect(recovered.status).toBe("ok");
    if (recovered.status === "ok") recovered.session.close();
    expect(careers.capturePortableProjectionIdentity()).toEqual(predecessor);
    expect(() => careers.saveSnapshot({ ...base, san: 17 })).not.toThrow();
  } finally {
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("Career projection hashes survive nested key reordering and canonical ordinary-store round trips", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-canonical-hash-"));
  const first = runtime();
  try {
    const fixture = await createFixture(root, first.dependencies);
    const reordered = structuredClone(fixture.projection);
    const base = reordered.records[0]?.base;
    if (!base) throw new Error("fixture Career projection lacks a base character");
    base.attributes = Object.fromEntries(Object.entries(base.attributes).reverse());
    base.skills = Object.fromEntries(Object.entries(base.skills).reverse());
    const canonicalHash = careerPortableProjectionHash(fixture.projection);
    expect(careerPortableProjectionHash(reordered)).toBe(canonicalHash);

    const validated = validateOrdinaryGameSessionSnapshot(fixture.envelope.snapshot);
    const { snapshotHash: _snapshotHash, ...snapshotWithoutHash } = validated;
    const reorderedSnapshot = createOrdinaryGameSessionSnapshot({
      ...snapshotWithoutHash,
      career: { mode: "complete", projection: reordered },
    });
    const { envelopeHash: _envelopeHash, ...envelopeWithoutHash } = fixture.envelope;
    const reorderedEnvelope = createOrdinarySessionEnvelope({ ...envelopeWithoutHash, snapshot: reorderedSnapshot });
    const ordinaryRoundTrip = new OrdinarySessionSnapshotStore({
      root: join(root, "canonical-ordinary-snapshots"),
      allowUncoordinatedTestWrites: true,
    });
    const saved = ordinaryRoundTrip.save(reorderedEnvelope);
    expect(saved.status).toBe("ok");
    const persisted = ordinaryRoundTrip.read(fixture.sessionId);
    if (persisted.status !== "ok") throw new Error("canonical ordinary round trip is unavailable");
    const persistedSnapshot = validateOrdinaryGameSessionSnapshot(persisted.value.snapshot);
    if (persistedSnapshot.career.mode !== "complete") throw new Error("canonical ordinary round trip lost Career projection");
    expect(careerPortableProjectionHash(persistedSnapshot.career.projection)).toBe(canonicalHash);

    const careers = new CareerFileStore(join(root, "canonical-career-root"));
    careers.replacePortableProjection(reordered);
    expect(careers.capturePortableProjectionIdentity().projectionHash).toBe(canonicalHash);
  } finally {
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("g0 only initializes an empty Career root, and malformed or oversized journals fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-g0-cas-"));
  const first = runtime();
  try {
    const fixture = await createFixture(root, first.dependencies);
    const g0 = { sessionId: "g0-empty", generation: 0, envelopeHash: "0".repeat(64) };
    const empty = new CareerFileStore(join(root, "g0-empty"));
    empty.reconcileOrdinaryProjection(g0, fixture.projection);
    const installed = empty.capturePortableProjectionIdentity();
    empty.reconcileOrdinaryProjection(g0, fixture.projection);
    expect(empty.capturePortableProjectionIdentity()).toEqual(installed);

    const third = new CareerFileStore(join(root, "g0-third"));
    third.replacePortableProjection(projectionWithSan(fixture.projection, 17));
    expect(() => third.reconcileOrdinaryProjection(g0, fixture.projection)).toThrow(CareerProjectionPredecessorConflict);

    const guardedRoot = join(root, "guarded");
    const guarded = new CareerFileStore(guardedRoot);
    guarded.replacePortableProjection(fixture.projection);
    writeFileSync(join(guardedRoot, ".ordinary-career-projection-commit.json"), "{not-json", "utf8");
    expect(() => guarded.capturePortableProjectionIdentity()).toThrow();
    writeFileSync(join(guardedRoot, ".ordinary-career-projection-commit.json"), "x".repeat(1025), "utf8");
    expect(() => guarded.capturePortableProjectionIdentity()).toThrow();
  } finally {
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("two session Career roots retain independent pending journals", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-isolation-cas-"));
  const first = runtime();
  try {
    const fixture = await createFixture(root, first.dependencies);
    const one = new CareerFileStore(join(root, "session-one"));
    const two = new CareerFileStore(join(root, "session-two"));
    one.replacePortableProjection(fixture.projection);
    two.replacePortableProjection(fixture.projection);
    const oneInput = {
      sessionId: "session-one", predecessorGeneration: 0, predecessorEnvelopeHash: "1".repeat(64),
      generation: 1, envelopeHash: "2".repeat(64), predecessor: one.capturePortableProjectionIdentity(),
    };
    const twoInput = {
      sessionId: "session-two", predecessorGeneration: 0, predecessorEnvelopeHash: "3".repeat(64),
      generation: 1, envelopeHash: "4".repeat(64), predecessor: two.capturePortableProjectionIdentity(),
    };
    const successor = projectionWithSan(fixture.projection, 17);
    const oneCommit = one.prepareOrdinaryProjectionCommit(oneInput, successor);
    const twoCommit = two.prepareOrdinaryProjectionCommit(twoInput, successor);
    expect(() => one.replacePortableProjection(successor)).toThrow(CareerProjectionPredecessorConflict);
    expect(() => two.replacePortableProjection(successor)).toThrow(CareerProjectionPredecessorConflict);
    one.resolveOrdinaryProjectionCommit(oneCommit, "predecessor");
    two.resolveOrdinaryProjectionCommit(twoCommit, "predecessor");
    expect(one.capturePortableProjectionIdentity()).toEqual(oneInput.predecessor);
    expect(two.capturePortableProjectionIdentity()).toEqual(twoInput.predecessor);
  } finally {
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a schema-valid journal substitution cannot turn the prepared successor back into its predecessor", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-journal-tamper-cas-"));
  const first = runtime();
  try {
    const fixture = await createFixture(root, first.dependencies);
    const careerDirectory = join(root, "careers", fixture.sessionId);
    const careers = new CareerFileStore(careerDirectory);
    const predecessor = careers.capturePortableProjectionIdentity();
    const intent = {
      sessionId: fixture.sessionId,
      predecessorGeneration: 0,
      predecessorEnvelopeHash: fixture.envelope.envelopeHash,
      generation: 1,
      envelopeHash: "e".repeat(64),
      predecessor,
    };
    const successor = projectionWithSan(fixture.projection, 17);
    const prepared = careers.prepareOrdinaryProjectionCommit(intent, successor);
    const markerPath = join(careerDirectory, ".ordinary-career-projection-commit.json");
    const tampered = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    tampered.successor = tampered.predecessor;
    writeFileSync(markerPath, JSON.stringify(tampered), "utf8");

    expect(() => careers.resolveOrdinaryProjectionCommit(prepared, "successor")).toThrow(CareerProjectionPredecessorConflict);
    expect(careerPortableProjectionHash(careers.exportPortableProjection())).toBe(predecessor.projectionHash);
    const base = careers.getSnapshot("Ada");
    if (!base) throw new Error("fixture Career predecessor is unavailable");
    expect(() => careers.saveSnapshot({ ...base, san: 17 })).toThrow(CareerProjectionPredecessorConflict);
  } finally {
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("an exact journal readback after a reported prepare write failure remains recoverably fenced", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-prepare-readback-cas-"));
  const first = runtime();
  const prototype = CareerFileStore.prototype as unknown as {
    atomicWriteRootControlFile: (name: string, body: string, maximum: number) => void;
  };
  const originalWriteControl = prototype.atomicWriteRootControlFile;
  let reportLateFailure = false;
  let targetCareerDirectory = "";
  prototype.atomicWriteRootControlFile = function (this: CareerFileStore, name: string, body: string, maximum: number): void {
    originalWriteControl.call(this, name, body, maximum);
    if (reportLateFailure && name === ".ordinary-career-projection-commit.json"
      && (this as unknown as { baseDir?: unknown }).baseDir === targetCareerDirectory) {
      throw new Error("injected late control fsync failure");
    }
  };
  try {
    const fixture = await createFixture(root, first.dependencies);
    targetCareerDirectory = join(root, "careers", fixture.sessionId);
    const careers = new CareerFileStore(targetCareerDirectory);
    const predecessor = careers.capturePortableProjectionIdentity();
    const intent = {
      sessionId: fixture.sessionId,
      predecessorGeneration: 0,
      predecessorEnvelopeHash: fixture.envelope.envelopeHash,
      generation: 1,
      envelopeHash: "d".repeat(64),
      predecessor,
    };
    reportLateFailure = true;
    expect(() => careers.prepareOrdinaryProjectionCommit(intent, projectionWithSan(fixture.projection, 17))).toThrow("injected late control fsync failure");
    expect(existsSync(join(targetCareerDirectory, ".ordinary-career-projection-commit.json"))).toBe(true);
    const base = careers.getSnapshot("Ada");
    if (!base) throw new Error("fixture Career predecessor is unavailable");
    expect(() => careers.saveSnapshot({ ...base, san: 17 })).toThrow(CareerProjectionPredecessorConflict);

    reportLateFailure = false;
    careers.reconcileOrdinaryProjection({
      sessionId: fixture.sessionId,
      generation: 0,
      envelopeHash: fixture.envelope.envelopeHash,
    }, fixture.projection);
    expect(existsSync(join(targetCareerDirectory, ".ordinary-career-projection-commit.json"))).toBe(false);
    expect(careers.capturePortableProjectionIdentity()).toEqual(predecessor);
    expect(() => careers.saveSnapshot({ ...base, san: 17 })).not.toThrow();
  } finally {
    reportLateFailure = false;
    prototype.atomicWriteRootControlFile = originalWriteControl;
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("an exact successor pointer is post-commit even when its store acknowledgement reports indeterminate", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-reported-failure-cas-"));
  const first = runtime();
  const prototype = OrdinarySessionSnapshotStore.prototype as unknown as {
    save: (raw: unknown, ...rest: unknown[]) => unknown;
  };
  const originalSave = prototype.save;
  let armed = false;
  let targetSessionId = "";
  prototype.save = function (this: OrdinarySessionSnapshotStore, raw: unknown, ...rest: unknown[]): unknown {
    const result = originalSave.apply(this, [raw, ...rest]);
    const envelope = raw as { sessionId?: unknown; generation?: unknown };
    if (armed && envelope.sessionId === targetSessionId && envelope.generation === 1
      && typeof result === "object" && result !== null && (result as { status?: unknown }).status === "ok") {
      return {
        status: "indeterminate",
        code: "ORDINARY_SNAPSHOT_INDETERMINATE",
        message: "injected acknowledgement failure after durable pointer",
        sessionId: targetSessionId,
      };
    }
    return result;
  };
  try {
    const fixture = await createFixture(root, first.dependencies);
    targetSessionId = fixture.sessionId;
    armed = true;
    const actionId = "ordinary-career-reported-failure-0001";
    const response = await request(root, first.dependencies, `/api/sessions/${fixture.sessionId}/action`, {
      input: "调查", actionId, expectedGeneration: 0,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ordinary_post_commit_recovery_required", ordinaryGeneration: 1 });
    expect(fixture.snapshots.read(fixture.sessionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
    expect(fixture.snapshots.findActionReceipt(fixture.sessionId, actionId)).toMatchObject({ status: "ok", value: { actionId } });
    const replay = await request(root, first.dependencies, `/api/sessions/${fixture.sessionId}/action`, {
      input: "调查", actionId, expectedGeneration: 0,
    });
    expect(replay.status).toBe(200);
  } finally {
    armed = false;
    prototype.save = originalSave;
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a prepared intent is cancelled after an admission-fence exception before ordinary CAS", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-precommit-exception-cas-"));
  const admission = new OrdinaryActionAdmissionCoordinator(join(root, "sessions"));
  const first = runtime({ ordinaryActionAdmission: admission });
  const prototype = OrdinaryActionAdmissionCoordinator.prototype as unknown as {
    withActiveFence: (...args: unknown[]) => unknown;
  };
  const originalWithActiveFence = prototype.withActiveFence;
  let armed = false;
  prototype.withActiveFence = function (this: OrdinaryActionAdmissionCoordinator, ...args: unknown[]): unknown {
    if (armed && this.root === admission.root) throw new Error("injected admission fence failure before ordinary CAS");
    return originalWithActiveFence.apply(this, args);
  };
  try {
    const fixture = await createFixture(root, first.dependencies);
    const careers = new CareerFileStore(join(root, "careers", fixture.sessionId));
    const base = careers.getSnapshot("Ada");
    if (!base) throw new Error("fixture Career predecessor is unavailable");
    armed = true;
    const response = await request(root, first.dependencies, `/api/sessions/${fixture.sessionId}/action`, {
      input: "调查", actionId: "ordinary-career-precommit-exception-0001", expectedGeneration: 0,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ordinary_persistence_unavailable", ordinaryGeneration: 0 });
    expect(fixture.snapshots.read(fixture.sessionId)).toMatchObject({ status: "ok", value: { generation: 0 } });
    // `resolve(predecessor)` removed the journal before returning. A normal
    // writer can publish again, proving no dangling intent survived the throw.
    expect(() => careers.saveSnapshot({ ...base, san: 17 })).not.toThrow();
    expect(first.registry.get(fixture.sessionId)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
  } finally {
    armed = false;
    prototype.withActiveFence = originalWithActiveFence;
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a snapshot successor without namespace successor authority cannot install Career or live state", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-namespace-gap-cas-"));
  const namespace = new SessionNamespaceCoordinator(join(root, "sessions"));
  const first = runtime({ sessionNamespace: namespace });
  const originalPublish = namespace.publishCommitted;
  let armed = false;
  namespace.publishCommitted = function (input: any): any {
    if (armed && input.nextIdentity?.generation === 1) {
      return originalPublish.call(this, {
        ...input,
        publish: (permit: unknown) => {
          input.publish(permit);
          return { status: "indeterminate" as const };
        },
      });
    }
    return originalPublish.call(this, input);
  };
  try {
    const fixture = await createFixture(root, first.dependencies);
    const careers = new CareerFileStore(join(root, "careers", fixture.sessionId));
    const predecessor = careers.getSnapshot("Ada");
    if (!predecessor) throw new Error("fixture Career predecessor is unavailable");
    armed = true;
    const response = await request(root, first.dependencies, `/api/sessions/${fixture.sessionId}/action`, {
      input: "调查", actionId: "ordinary-career-namespace-gap-0001", expectedGeneration: 0,
    });
    expect(response.status).toBe(503);
    expect(fixture.snapshots.read(fixture.sessionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
    expect(namespace.read(fixture.sessionId)?.expectedIdentity).toMatchObject({ generation: 0 });
    expect(careers.getSnapshot("Ada")).toEqual(predecessor);
    expect(first.registry.has(fixture.sessionId)).toBe(false);

    // Reintroduce a valid live g0 object without touching the real Career
    // root. The route must not use snapshot g1 while namespace remains g0.
    const staleLive = restoreTarget(fixture.sessionId, fixture.envelope.access, {
      careerRoot: join(root, "stale-live-careers"), sessionRoot: join(root, "sessions"),
    }, { ordinaryDurableHostCapability: first.durableHostCapability() });
    staleLive.restoreOrdinarySessionSnapshot(fixture.envelope.snapshot);
    acknowledgeOrdinaryDurableIdentity(staleLive, first.durableHostCapability(), {
      generation: fixture.envelope.generation,
      envelopeHash: fixture.envelope.envelopeHash,
      snapshotHash: fixture.envelope.snapshot.snapshotHash,
    });
    first.registry.set(fixture.sessionId, staleLive);
    expect((await request(root, first.dependencies, `/api/sessions/${fixture.sessionId}`)).status).toBe(503);
    expect((await request(root, first.dependencies, `/api/sessions/${fixture.sessionId}/action`, {
      input: "调查", actionId: "ordinary-career-namespace-gap-0002", expectedGeneration: 0,
    })).status).toBe(503);
    expect(first.registry.get(fixture.sessionId)).toBe(staleLive);
    expect(careers.getSnapshot("Ada")).toEqual(predecessor);

    const rejected = hydrateOrdinarySession(fixture.sessionId, {
      snapshots: fixture.snapshots,
      sessionNamespace: namespace,
      storage: { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
      createSession: (id, access, runtimeDependencies) => restoreTarget(id, access, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, runtimeDependencies),
    });
    expect(rejected).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CONFLICT" });
    expect(careers.getSnapshot("Ada")).toEqual(predecessor);
  } finally {
    armed = false;
    namespace.publishCommitted = originalPublish;
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
