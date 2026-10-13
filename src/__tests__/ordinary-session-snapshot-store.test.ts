import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { GameSession } from "../api/game-session";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, OrdinarySessionSnapshotStore as OrdinarySessionSnapshotStoreImplementation, createOrdinarySessionEnvelope, nextOrdinarySessionArchive, ordinaryActionRequestHash, ordinarySessionEnvelopeHash, type OrdinaryPersistedActionRecord, type OrdinarySessionEnvelope, type OrdinarySessionSnapshotStoreOptions } from "../api/ordinary-session-snapshot-store";
import { CompiledSessionSnapshotCoordinator, SnapshotCoordinatorFailure } from "../api/compiled-session-snapshot-coordinator";
import { compiledSessionSnapshotNodeFileOps, type CompiledSessionSnapshotFileOps } from "../api/compiled-session-snapshot";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";

/** Store-only fixtures opt into raw writes explicitly. HTTP paths do not. */
class OrdinarySessionSnapshotStore extends OrdinarySessionSnapshotStoreImplementation {
  constructor(options: OrdinarySessionSnapshotStoreOptions = {}) {
    super({ ...options, allowUncoordinatedTestWrites: true });
  }
}

function fixture(id: string): { session: GameSession; initial: OrdinarySessionEnvelope } {
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-store-owner" });
  const session = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined, undefined, access, "development_fallback");
  return { session, initial: createOrdinarySessionEnvelope({ kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: session.exportOrdinarySessionSnapshot(), idempotency: [] }) };
}

function memoryFileOps(): CompiledSessionSnapshotFileOps & { fileCount(): number; byteCount(): number; listCount(): number } {
  const directories = new Set<string>(); const files = new Map<string, string>(); let lists = 0;
  return {
    mkdir(path) { directories.add(path); }, exists(path) { return files.has(path) || directories.has(path); },
    list(path) { lists++; if (!directories.has(path)) throw new Error("missing memory directory"); return [...files.keys()].filter((entry) => dirname(entry) === path).map((entry) => basename(entry)); },
    kind(path) { return directories.has(path) ? "directory" : files.has(path) ? "regular" : "missing"; },
    size(path) { const value = files.get(path); if (value === undefined) throw new Error("missing memory file"); return new TextEncoder().encode(value).byteLength; },
    read(path, maxBytes) { const value = files.get(path); if (value === undefined || new TextEncoder().encode(value).byteLength > maxBytes) throw new Error("missing or oversized memory file"); return value; },
    writeNew(path, value) { if (files.has(path) || directories.has(path)) throw new Error("memory immutable collision"); files.set(path, value); },
    writeReplace(path, value) { if (directories.has(path)) throw new Error("memory unsafe replace"); files.set(path, value); },
    remove(path) { if (!files.delete(path)) throw new Error("missing memory file"); },
    fileCount() { return files.size; },
    byteCount() { return [...files.values()].reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0); },
    listCount() { return lists; },
  };
}

async function successor(store: OrdinarySessionSnapshotStore, session: GameSession, initial: OrdinarySessionEnvelope, actionId = "ordinary-action-0001"): Promise<OrdinarySessionEnvelope> {
  const input = "/help";
  const acted = await session.act(input);
  // Mirror the wire receipt that the HTTP handler persists.  A generation-one
  // envelope is deliberately not allowed to reuse its round-zero snapshot.
  const generation = initial.generation + 1;
  const response = JSON.parse(JSON.stringify({ ...acted, summary: session.getSummary(), sessionKind: "ordinary", ordinaryGeneration: generation }));
  const snapshot = session.exportOrdinarySessionSnapshot();
  const record: OrdinaryPersistedActionRecord = { actionId, input, pcId: null, expectedGeneration: initial.generation, generation, status: 200, requestHash: ordinaryActionRequestHash(initial.sessionId, actionId, input, null, initial.generation), response };
  const archive = nextOrdinarySessionArchive(initial.sessionId, initial.archive, record, snapshot);
  return createOrdinarySessionEnvelope({
    kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: initial.sessionId, generation, previousEnvelopeHash: initial.envelopeHash, access: initial.access, snapshot,
    idempotency: [...initial.idempotency, record].slice(-128), archive,
    replayDirectory: store.prepareOrdinaryReplayDirectory(initial.sessionId, initial.replayDirectory, record, archive.headHash!),
  });
}

/** Storage-scale fixture: the snapshot is intentionally unchanged while each
 * durable receipt/generation is distinct. This isolates archive cost from LLM
 * or gameplay turn latency. */
function syntheticSuccessor(store: OrdinarySessionSnapshotStore, initial: OrdinarySessionEnvelope, actionId: string): OrdinarySessionEnvelope {
  const generation = initial.generation + 1;
  const previous = initial.idempotency.at(-1)!;
  const response = structuredClone(previous.response) as Record<string, unknown>;
  response.ordinaryGeneration = generation;
  const record: OrdinaryPersistedActionRecord = {
    actionId, input: previous.input, pcId: previous.pcId, expectedGeneration: initial.generation, generation, status: 200,
    requestHash: ordinaryActionRequestHash(initial.sessionId, actionId, previous.input, previous.pcId, initial.generation), response: response as OrdinaryPersistedActionRecord["response"],
  };
  const archive = nextOrdinarySessionArchive(initial.sessionId, initial.archive, record, initial.snapshot);
  return createOrdinarySessionEnvelope({
    kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: initial.sessionId, generation,
    previousEnvelopeHash: initial.envelopeHash, access: initial.access, snapshot: initial.snapshot, idempotency: [...initial.idempotency, record].slice(-128), archive,
    replayDirectory: store.prepareOrdinaryReplayDirectory(initial.sessionId, initial.replayDirectory, record, archive.headHash!),
  });
}

describe("ordinary durable envelope store", () => {
  test("does not erase dangerous response object or array own properties before closed receipt validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-closed-response-"));
    const { session, initial } = fixture("ordinary-closed-response");
    try {
      const valid = await successor(new OrdinarySessionSnapshotStore({ root }), session, initial, "ordinary-closed-response-0001");
      const recreate = (mutate: (response: Record<string, unknown>) => void) => {
        const forged = structuredClone(valid) as any;
        mutate(forged.idempotency[0].response as Record<string, unknown>);
        const { envelopeHash: _ignored, ...unsigned } = forged;
        return () => createOrdinarySessionEnvelope(unsigned);
      };
      expect(recreate((response) => Object.defineProperty(response, "__proto__", { enumerable: true, value: "ignored" }))).toThrow();
      expect(recreate((response) => Object.defineProperty(response.events as unknown[], "__proto__", { enumerable: true, value: "ignored" }))).toThrow();
      expect(recreate((response) => Object.defineProperty(response.events as unknown[], "hidden", { enumerable: false, value: "ignored" }))).toThrow();
      expect(recreate((response) => Object.defineProperty(response.events as unknown[], "0", { enumerable: true, get: () => null }))).toThrow();
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects a default raw write before it creates any subordinate files", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-default-fence-"));
    const { session, initial } = fixture("ordinary-default-fence");
    try {
      const productionStore = new OrdinarySessionSnapshotStoreImplementation({ root: join(root, "snapshots") });
      expect(productionStore.save(initial)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_NAMESPACE_FENCED" });
      expect(productionStore.isOccupied(initial.sessionId)).toBe(false);
      expect(readdirSync(root)).toEqual([]);
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("treats an orphaned replay-directory node as occupied before a generation-zero save", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-replay-node-occupancy-"));
    const { session, initial } = fixture("ordinary-replay-node-occupied");
    const orphan = join(root, `${initial.sessionId}.${"a".repeat(64)}.ordinary-action-replay-directory-node.json`);
    try {
      writeFileSync(orphan, "{}\n");
      const store = new OrdinarySessionSnapshotStore({ root });

      expect(store.listOccupiedSessionIds()).toEqual([initial.sessionId]);
      expect(store.isOccupied(initial.sessionId)).toBe(true);
      expect(store.save(initial)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CONFLICT" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("opens a real 1.4 coordinator root and publishes its first 1.5 envelope successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-coordinator-upgrade-"));
    const snapshotRoot = join(root, "snapshots");
    const { session, initial: currentInitial } = fixture("ordinary-coordinator-upgrade");
    const legacy = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: currentInitial.sessionId, generation: 0, previousEnvelopeHash: null, access: currentInitial.access,
      snapshot: currentInitial.snapshot, idempotency: [],
    });
    const stablePolicy = {
      schemaVersion: LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      maxEntries: 4096,
      maxBytes: 512 * 1024 * 1024,
    };
    try {
      mkdirSync(snapshotRoot);
      const legacyCoordinator = new CompiledSessionSnapshotCoordinator(snapshotRoot, LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, {
        domain: "ordinary-session-envelope-cas", fileName: ".ordinary-session-envelope-write.sqlite",
      });
      legacyCoordinator.initializePolicy(stablePolicy);
      legacyCoordinator.finishPublication();

      // This is an actual legacy wire envelope beside the real legacy SQLite
      // policy. The no-op test coordinator only stands in for the historical
      // writer; the upgrade reader/publisher below uses the production one.
      const legacyWriter = new OrdinarySessionSnapshotStore({
        root: snapshotRoot,
        coordinatorFactory: () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } }),
      });
      expect(legacyWriter.save(legacy)).toMatchObject({ status: "ok" });
      const successorEnvelope = await successor(legacyWriter, session, legacy, "ordinary-coordinator-upgrade-0001");

      const upgraded = new OrdinarySessionSnapshotStore({ root: snapshotRoot });
      expect(upgraded.read(legacy.sessionId)).toMatchObject({ status: "ok", value: { schemaVersion: LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, generation: 0 } });
      expect(upgraded.save(successorEnvelope)).toMatchObject({ status: "ok" });
      expect(upgraded.read(legacy.sessionId)).toMatchObject({ status: "ok", value: { schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, generation: 1 } });

      const freshRoot = join(root, "fresh-snapshots");
      const fresh = new OrdinarySessionSnapshotStore({ root: freshRoot });
      expect(fresh.save(currentInitial)).toMatchObject({ status: "ok" });
      const freshCoordinator = new CompiledSessionSnapshotCoordinator(freshRoot, LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, {
        domain: "ordinary-session-envelope-cas", fileName: ".ordinary-session-envelope-write.sqlite",
      });
      freshCoordinator.initializePolicy(stablePolicy);
      freshCoordinator.finishPublication();

      const quotaMismatch = new OrdinarySessionSnapshotStore({ root: snapshotRoot, maxEntries: stablePolicy.maxEntries - 1 });
      expect(quotaMismatch.save(successorEnvelope)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_POLICY_MISMATCH" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("requires a one-shot namespace permit before its first snapshot write when the root is namespace-required", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-namespace-gate-"));
    const { session, initial } = fixture("ordinary-namespace-gate");
    try {
      const namespace = new SessionNamespaceCoordinator(join(root, "namespace"));
      const store = new OrdinarySessionSnapshotStore({
        root: join(root, "snapshots"),
        namespacePublicationGate: { required: true, consume: namespace.consumePublicationPermit.bind(namespace) },
      });
      // This is the pre-fix regression: direct g0 save must be stopped before
      // it creates the subordinate root or writes an immutable body/header.
      expect(store.save(initial)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_NAMESPACE_FENCED" });
      expect(store.isOccupied(initial.sessionId)).toBe(false);

      const prepared = namespace.prepare({
        reservation: namespace.reserve({ sessionId: initial.sessionId, kind: "ordinary" }),
        expectedIdentity: { hash: initial.envelopeHash, generation: 0, format: "ordinary-session-envelope-v1" },
      });
      const published = namespace.publishPrepared({
        reservation: prepared,
        publish: (permit) => {
          const saved = store.save(initial, { permit });
          expect(saved.status).toBe("ok");
          const readback = store.read(initial.sessionId);
          expect(readback.status).toBe("ok");
          return readback.status === "ok"
            ? { status: "published", observedIdentity: { hash: readback.value.envelopeHash, generation: readback.value.generation, format: "ordinary-session-envelope-v1" } }
            : { status: "not-published" };
        },
      });
      expect(published).toMatchObject({ status: "committed", record: { kind: "ordinary" } });
      // A consumed permit cannot be replayed after the coordinator callback.
      expect(store.save(initial, { permit: {
        token: "forged-permit-token-that-is-not-a-real-capability",
        kind: "ordinary", sessionId: initial.sessionId, fencingToken: prepared.fencingToken,
        previousIdentity: null, nextIdentity: { hash: initial.envelopeHash, generation: 0, format: "ordinary-session-envelope-v1" },
      } })).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_NAMESPACE_FENCED" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("does exact immutable replay but gives two stores one CAS winner for a predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-cas-"));
    const { session, initial } = fixture("ordinary-cas");
    try {
      const first = new OrdinarySessionSnapshotStore({ root }); const second = new OrdinarySessionSnapshotStore({ root });
      expect(first.save(initial).status).toBe("ok");
      const next = await successor(first, session, initial);
      expect(first.save(next).status).toBe("ok");
      expect(first.save(next).status).toBe("ok");
      const contender = structuredClone(next) as OrdinarySessionEnvelope;
      contender.idempotency[0]!.actionId = "ordinary-action-0002";
      contender.idempotency[0]!.requestHash = ordinaryActionRequestHash(initial.sessionId, "ordinary-action-0002", "/help", null, 0);
      const { envelopeHash: _ignored, ...unsigned } = contender;
      contender.envelopeHash = ordinarySessionEnvelopeHash(unsigned);
      expect(second.save(contender)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CONFLICT" });
      expect(second.read(initial.sessionId)).toMatchObject({ status: "ok", value: { generation: 1, envelopeHash: next.envelopeHash } });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("fails closed for unsafe roots and pre-publication quota exhaustion", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-policy-")); const { session, initial } = fixture("ordinary-policy");
    try {
      const rootFile = join(root, "not-a-directory"); writeFileSync(rootFile, "x");
      expect(new OrdinarySessionSnapshotStore({ root: rootFile }).save(initial)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_STORAGE_FAILED" });
      expect(new OrdinarySessionSnapshotStore({ root: join(root, "quota"), maxEntries: 0, maxBytes: 0 }).save(initial)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects an archive-directory successor at admission before its pointer can advance", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-archive-quota-")); const { session, initial } = fixture("ordinary-archive-quota");
    try {
      const coordinatorFactory = () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } });
      const store = new OrdinarySessionSnapshotStore({ root, maxEntries: 4, maxBytes: 16 * 1024 * 1024, fileOps: memoryFileOps(), coordinatorFactory });
      expect(store.save(initial)).toMatchObject({ status: "ok" });
      const next = await successor(store, session, initial, "ordinary-archive-quota-action-0001");
      expect(store.save(next)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED" });
      expect(store.read(initial.sessionId)).toMatchObject({ status: "ok", value: { generation: 0 } });
      expect(store.findActionReceipt(initial.sessionId, "ordinary-archive-quota-action-0001")).toMatchObject({ status: "ok", value: null });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects a final-fitting successor when its atomic temp-plus-final peak exceeds quota before any business write", async () => {
    const root = "memory://ordinary-atomic-peak"; const { session, initial } = fixture("ordinary-atomic-peak");
    const coordinatorFactory = () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } });
    const backing = memoryFileOps(); let armed = false; let businessWrites = 0;
    const fileOps: CompiledSessionSnapshotFileOps = {
      ...backing,
      writeNew(path, value) {
        if (armed && !path.endsWith(".ordinary-session-envelope-usage.json")) businessWrites++;
        backing.writeNew(path, value);
      },
      writeReplace(path, value) {
        if (armed && !path.endsWith(".ordinary-session-envelope-usage.json")) businessWrites++;
        backing.writeReplace(path, value);
      },
    };
    try {
      // Generation one settles at five regular entries: manifest, current
      // header/body, archive receipt, and replay node. Its old current body
      // is retired. The ordinary final-footprint admission is therefore six
      // at most before retirement, but the ordered archive/node/body writeNew
      // sequence needs a seventh temp-or-link entry transiently.
      const store = new OrdinarySessionSnapshotStore({ root, maxEntries: 6, maxBytes: 16 * 1024 * 1024, coordinatorFactory, fileOps });
      expect(store.save(initial)).toMatchObject({ status: "ok" });
      const next = await successor(store, session, initial, "ordinary-atomic-peak-0001");
      armed = true;
      expect(store.save(next)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED" });
      expect(businessWrites).toBe(0);
      expect(store.read(initial.sessionId)).toMatchObject({ status: "ok", value: { generation: 0 } });
    } finally { session.close(); }
  });

  test("reserves atomic temp-plus-final bytes before an archive/node/body publication whose settled pre-clean footprint fits", async () => {
    const { session, initial } = fixture("ordinary-atomic-byte-peak");
    const coordinatorFactory = () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } });
    try {
      const builder = new OrdinarySessionSnapshotStore({ root: "memory://ordinary-atomic-byte-builder", maxEntries: 64, maxBytes: 16 * 1024 * 1024, coordinatorFactory, fileOps: memoryFileOps() });
      expect(builder.save(initial)).toMatchObject({ status: "ok" });
      const next = await successor(builder, session, initial, "ordinary-atomic-byte-peak-0001");

      // Stop a generous probe after the durable pointer but before retirement
      // or final clean. That is exactly the normal final-footprint admission
      // state: all final artifacts exist, while the predecessor body remains.
      const preCleanBacking = memoryFileOps();
      let stopAfterSuccessorPointer = false;
      const preClean = new OrdinarySessionSnapshotStore({
        root: "memory://ordinary-atomic-byte-preclean", maxEntries: 64, maxBytes: 16 * 1024 * 1024, coordinatorFactory, fileOps: preCleanBacking,
        testHooks: { onPublicationStage(stage) { if (stopAfterSuccessorPointer && stage === "pointer-durable-before-clean") throw new Error("stop before cleanup"); } },
      });
      expect(preClean.save(initial)).toMatchObject({ status: "ok" });
      stopAfterSuccessorPointer = true;
      expect(preClean.save(next)).toMatchObject({ status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE" });
      const settledBeforeCleanupBytes = preCleanBacking.byteCount();

      const targetBacking = memoryFileOps(); let armed = false; let businessWrites = 0;
      const target = new OrdinarySessionSnapshotStore({
        root: "memory://ordinary-atomic-byte-target", maxEntries: 64, maxBytes: settledBeforeCleanupBytes, coordinatorFactory,
        fileOps: {
          ...targetBacking,
          writeNew(path, value) { if (armed && !path.endsWith(".ordinary-session-envelope-usage.json")) businessWrites++; targetBacking.writeNew(path, value); },
          writeReplace(path, value) { if (armed && !path.endsWith(".ordinary-session-envelope-usage.json")) businessWrites++; targetBacking.writeReplace(path, value); },
        },
      });
      expect(target.save(initial)).toMatchObject({ status: "ok" });
      armed = true;
      expect(target.save(next)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED" });
      expect(businessWrites).toBe(0);
    } finally { session.close(); }
  });

  test("returns a structured refusal when a fresh or unsafe root is read", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-read-root-"));
    try {
      expect(new OrdinarySessionSnapshotStore({ root: join(root, "missing") }).read("ordinary-missing")).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_NOT_FOUND" });
      const fileRoot = join(root, "file-root"); writeFileSync(fileRoot, "x");
      expect(new OrdinarySessionSnapshotStore({ root: fileRoot }).read("ordinary-missing")).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_STORAGE_FAILED" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("runs orphan reconciliation under the same publication lock that protects a writer body", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-gc-lock-"));
    const firstFixture = fixture("ordinary-gc-first"); const secondFixture = fixture("ordinary-gc-second");
    const gate = { locked: false }; let second: OrdinarySessionSnapshotStore; let nested: unknown; let entered = false;
    const coordinatorFactory = () => ({
      initializePolicy() {},
      beginPublication() {
        if (gate.locked) throw new SnapshotCoordinatorFailure("SNAPSHOT_BUSY", "controlled contender is busy");
        gate.locked = true;
      },
      finishPublication() { gate.locked = false; return {}; },
    });
    const first = new OrdinarySessionSnapshotStore({ root, coordinatorFactory, fileOps: {
      ...compiledSessionSnapshotNodeFileOps,
      writeNew(path, value) {
        compiledSessionSnapshotNodeFileOps.writeNew(path, value);
        if (!entered) { entered = true; nested = second.save(secondFixture.initial); }
      },
    } });
    second = new OrdinarySessionSnapshotStore({ root, coordinatorFactory });
    try {
      expect(first.save(firstFixture.initial)).toMatchObject({ status: "ok" });
      expect(nested).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_BUSY" });
      expect(first.read(firstFixture.initial.sessionId)).toMatchObject({ status: "ok", value: { envelopeHash: firstFixture.initial.envelopeHash } });
    } finally { firstFixture.session.close(); secondFixture.session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("fails closed on an unsafe pointer leaf before reading it", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-unsafe-leaf-")); const { session, initial } = fixture("ordinary-unsafe-leaf");
    try {
      mkdirSync(join(root, `${initial.sessionId}.ordinary-current.json`));
      expect(new OrdinarySessionSnapshotStore({ root }).readHeader(initial.sessionId)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_STORAGE_FAILED" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("marks usage dirty before every new-locator artifact, then rebuilds and collects a body written by a failed publish", () => {
    const root = "memory://ordinary-manifest-prebody";
    const coordinatorFactory = () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } });
    const backing = memoryFileOps();
    const firstFixture = fixture("ordinary-manifest-prebody-first");
    const failedFixture = fixture("ordinary-manifest-prebody-failed");
    const nextFixture = fixture("ordinary-manifest-prebody-next");
    try {
      const policy = { root, maxEntries: 6, maxBytes: 16 * 1024 * 1024, coordinatorFactory };
      expect(new OrdinarySessionSnapshotStore({ ...policy, fileOps: backing }).save(firstFixture.initial)).toMatchObject({ status: "ok" });
      let failBodyOnce = true;
      const faulting = new OrdinarySessionSnapshotStore({ ...policy, fileOps: {
        ...backing,
        writeNew(path, value) {
          backing.writeNew(path, value);
          if (failBodyOnce && path.endsWith(".ordinary-envelope.json")) { failBodyOnce = false; throw new Error("body write completed then failed"); }
        },
      } });
      expect(faulting.save(failedFixture.initial)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_STORAGE_FAILED" });
      const listsBeforeRecovery = backing.listCount();
      // The failed body's immutable file is an orphan. A clean marker here
      // would undercount it and admit this third pair over maxEntries=6.
      expect(new OrdinarySessionSnapshotStore({ ...policy, fileOps: backing }).save(nextFixture.initial)).toMatchObject({ status: "ok" });
      expect(backing.listCount()).toBeGreaterThan(listsBeforeRecovery);
      expect(backing.fileCount()).toBe(5); // manifest plus two authoritative body/header pairs
    } finally { firstFixture.session.close(); failedFixture.session.close(); nextFixture.session.close(); }
  });

  test("does not publish any artifact when the pre-publication dirty marker fails", () => {
    const root = "memory://ordinary-manifest-dirty-write";
    const coordinatorFactory = () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } });
    const backing = memoryFileOps(); const { session, initial } = fixture("ordinary-manifest-dirty-write");
    try {
      const store = new OrdinarySessionSnapshotStore({ root, maxEntries: 8, maxBytes: 16 * 1024 * 1024, coordinatorFactory, fileOps: {
        ...backing,
        writeNew(path, value) {
          if (path.endsWith(".ordinary-session-envelope-usage.json") && value.includes('"clean":false')) throw new Error("dirty marker unavailable");
          backing.writeNew(path, value);
        },
        writeReplace(path, value) {
          if (path.endsWith(".ordinary-session-envelope-usage.json") && value.includes('"clean":false')) throw new Error("dirty marker unavailable");
          backing.writeReplace(path, value);
        },
      } });
      expect(store.save(initial)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_STORAGE_FAILED" });
      // Admission now measures a missing manifest before materializing it;
      // neither control marker nor business artifact may have been attempted.
      expect(backing.fileCount()).toBe(0);
      expect(store.read(initial.sessionId)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_NOT_FOUND" });
    } finally { session.close(); }
  });

  test("a final clean-manifest failure leaves recovery state so the next writer rebuilds before quota admission", () => {
    const root = "memory://ordinary-manifest-final-clean";
    const coordinatorFactory = () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } });
    const backing = memoryFileOps();
    const firstFixture = fixture("ordinary-manifest-final-first");
    const failedFixture = fixture("ordinary-manifest-final-failed");
    const nextFixture = fixture("ordinary-manifest-final-next");
    try {
      const policy = { root, maxEntries: 6, maxBytes: 16 * 1024 * 1024, coordinatorFactory };
      expect(new OrdinarySessionSnapshotStore({ ...policy, fileOps: backing }).save(firstFixture.initial)).toMatchObject({ status: "ok" });
      const faulting = new OrdinarySessionSnapshotStore({ ...policy, fileOps: {
        ...backing,
        writeReplace(path, value) {
          if (path.endsWith(".ordinary-session-envelope-usage.json") && value.includes('"clean":true')) throw new Error("clean manifest unavailable");
          backing.writeReplace(path, value);
        },
      } });
      expect(faulting.save(failedFixture.initial)).toMatchObject({ status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE" });
      const listsBeforeRecovery = backing.listCount();
      expect(new OrdinarySessionSnapshotStore({ ...policy, fileOps: backing }).save(nextFixture.initial)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED" });
      expect(backing.listCount()).toBeGreaterThan(listsBeforeRecovery);
      expect(backing.fileCount()).toBe(5); // manifest plus the two published body/header pairs
    } finally { firstFixture.session.close(); failedFixture.session.close(); nextFixture.session.close(); }
  });

  test("does not trust a legacy clean usage manifest that lacks the publication barrier marker", () => {
    const root = resolve("memory://ordinary-manifest-legacy-clean");
    const coordinatorFactory = () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } });
    const backing = memoryFileOps(); const { session, initial } = fixture("ordinary-manifest-legacy-clean");
    try {
      backing.mkdir(root);
      backing.writeNew(join(root, ".ordinary-session-envelope-usage.json"), `${JSON.stringify({ kind: "ordinary-session-envelope-usage", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, clean: true, entries: 0, bytes: 0 })}\n`);
      let manifestReplacements = 0;
      const fileOps: CompiledSessionSnapshotFileOps = {
        ...backing,
        writeReplace(path, value) {
          if (path.endsWith(".ordinary-session-envelope-usage.json")) manifestReplacements++;
          backing.writeReplace(path, value);
        },
      };
      expect(new OrdinarySessionSnapshotStore({ root, maxEntries: 8, maxBytes: 16 * 1024 * 1024, coordinatorFactory, fileOps }).save(initial)).toMatchObject({ status: "ok" });
      // Re-measure without materializing a clean control file, then perform
      // the publication barrier(dirty) and final(clean). The pre-barrier
      // implementation only performed the last replacement.
      expect(manifestReplacements).toBe(2);
      expect(backing.read(join(root, ".ordinary-session-envelope-usage.json"), 16 * 1024)).toContain('"barrier":"dirty-before-artifact-v1"');
    } finally { session.close(); }
  });

  test("rejects a rehashed receipt whose HTTP generation or summary binding is forged", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-receipt-contract-")); const { session, initial } = fixture("ordinary-receipt-contract");
    try {
      const valid = await successor(new OrdinarySessionSnapshotStore({ root }), session, initial);
      const forged = structuredClone(valid) as OrdinarySessionEnvelope;
      (forged.idempotency[0]!.response as { ordinaryGeneration: number }).ordinaryGeneration = 77;
      const { envelopeHash: _ignored, ...unsigned } = forged;
      forged.envelopeHash = ordinarySessionEnvelopeHash(unsigned);
      expect(new OrdinarySessionSnapshotStore({ root }).save(forged)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_INCOMPATIBLE" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects a rehashed terminal receipt that forges snapshot-projected player, scene, narrative, or summary data", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-terminal-receipt-")); const { session, initial } = fixture("ordinary-terminal-receipt");
    const rehash = (value: OrdinarySessionEnvelope) => {
      const { envelopeHash: _ignored, ...unsigned } = value;
      value.envelopeHash = ordinarySessionEnvelopeHash(unsigned);
      return value;
    };
    try {
      const valid = await successor(new OrdinarySessionSnapshotStore({ root }), session, initial);
      const cases: Array<(receipt: Record<string, unknown>) => void> = [
        (receipt) => { ((receipt.state as Record<string, unknown>).player as Record<string, unknown>).hp = 999; },
        (receipt) => { (receipt.state as Record<string, unknown>).scene = "forged-scene"; },
        (receipt) => { receipt.narrative = "forged narrative"; },
        (receipt) => { (receipt.summary as Record<string, unknown>).playerName = "forged player"; },
        (receipt) => { receipt.dead = !(receipt.dead as boolean); },
        (receipt) => { (receipt.sanity as Record<string, unknown>).currentSAN = 99; },
        (receipt) => { receipt.events = [{ speaker: "系统", content: "forged", type: "system", extra: true }]; },
        (receipt) => { receipt.dice = [{ expr: "d6", total: 1, unexpected: true }]; },
      ];
      for (const mutate of cases) {
        const forged = structuredClone(valid) as OrdinarySessionEnvelope;
        mutate(forged.idempotency[0]!.response as unknown as Record<string, unknown>);
        expect(new OrdinarySessionSnapshotStore({ root }).save(rehash(forged))).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_INCOMPATIBLE" });
      }
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("fails closed when a rehashed non-terminal hot receipt disagrees with its immutable archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-hot-archive-binding-")); const { session, initial } = fixture("ordinary-hot-archive-binding");
    try {
      const store = new OrdinarySessionSnapshotStore({ root });
      expect(store.save(initial)).toMatchObject({ status: "ok" });
      const first = await successor(store, session, initial, "ordinary-hot-archive-0001");
      expect(store.save(first)).toMatchObject({ status: "ok" });
      // This is generation two, so entry zero is structurally valid but not
      // terminal. Admission must still preserve the already-audited hot
      // window; the forged pointer must never become authoritative.
      const forged = syntheticSuccessor(store, first, "ordinary-hot-archive-0002");
      (forged.idempotency[0]!.response as Record<string, unknown>).narrative = "forged old hot receipt";
      const { envelopeHash: _ignored, ...unsigned } = forged;
      forged.envelopeHash = ordinarySessionEnvelopeHash(unsigned);
      expect(store.save(forged)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CONFLICT" });
      expect(store.read(first.sessionId)).toMatchObject({ status: "ok", value: { generation: 1, envelopeHash: first.envelopeHash } });
      expect(store.findActionReceipt(first.sessionId, "ordinary-hot-archive-0001")).toMatchObject({ status: "ok", value: { response: { narrative: expect.not.stringContaining("forged") } } });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("keeps 200 committed action receipts compact and gives bounded cold and unknown lookup", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-replay-index-")); const { session, initial } = fixture("ordinary-replay-index");
    try {
      // The storage-scale assertion exercises the immutable protocol itself;
      // separate CAS tests above cover SQLite locking. Avoid opening SQLite
      // 200 times solely to measure replay shape on Windows CI.
      const coordinatorFactory = () => ({ initializePolicy() {}, beginPublication() {}, finishPublication() { return {}; } });
      const backing = memoryFileOps();
      const store = new OrdinarySessionSnapshotStore({ root, coordinatorFactory, fileOps: backing });
      expect(store.save(initial)).toMatchObject({ status: "ok" });
      let current = await successor(store, session, initial, "ordinary-replay-0001");
      expect(store.save(current)).toMatchObject({ status: "ok" });
      const listCallsAfterWarmup = backing.listCount();
      // A cached direct successor must not enumerate the full prior Map. The
      // one forbidden operation is exactly what `new Map(cached.nodes)` would
      // perform; AVL derivation itself only does get/set/delete on O(log n)
      // nodes. Keep this narrowly scoped around the 199 warm commits.
      const mapPrototype = Map.prototype as { [Symbol.iterator]: (this: Map<unknown, unknown>) => Iterator<unknown> };
      const originalMapIterator = mapPrototype[Symbol.iterator]; let copiedCheckpointMaps = 0;
      mapPrototype[Symbol.iterator] = function (this: Map<unknown, unknown>): Iterator<unknown> {
        copiedCheckpointMaps++;
        return originalMapIterator.call(this);
      };
      try {
        for (let number = 2; number <= 200; number++) {
          current = syntheticSuccessor(store, current, `ordinary-replay-${String(number).padStart(4, "0")}`);
          expect(store.save(current)).toMatchObject({ status: "ok" });
        }
      } finally { mapPrototype[Symbol.iterator] = originalMapIterator; }
      expect(store.read(initial.sessionId)).toMatchObject({ status: "ok", value: { generation: 200, idempotency: expect.any(Array), replayDirectory: { count: 200 } } });
      expect(backing.listCount()).toBe(listCallsAfterWarmup); // clean manifest: no root scan per commit
      expect(copiedCheckpointMaps).toBe(0); // no O(n) checkpoint Map copy per normal action
      let reads = 0;
      const countedOps: CompiledSessionSnapshotFileOps = { ...backing, read(path, maxBytes) { reads++; return backing.read(path, maxBytes); } };
      const restarted = new OrdinarySessionSnapshotStore({ root, fileOps: countedOps, coordinatorFactory });
      const replay = restarted.findActionReceipt(initial.sessionId, "ordinary-replay-0001");
      expect(replay).toMatchObject({ status: "ok", value: { actionId: "ordinary-replay-0001", generation: 1 } });
      const conflictingHash = ordinaryActionRequestHash(initial.sessionId, "ordinary-replay-0001", "/different", null, 0);
      expect((replay.status === "ok" && replay.value ? replay.value.requestHash : undefined)).not.toBe(conflictingHash);
      // The authenticated AVL path is bounded; no archive-chain walk occurs.
      expect(reads).toBeLessThan(32);
      reads = 0;
      expect(restarted.findActionReceipt(initial.sessionId, "ordinary-replay-never-seen-0000")).toMatchObject({ status: "ok", value: null });
      expect(reads).toBeLessThan(28);
      // One compact receipt plus one live directory node per action, not a
      // full world snapshot per receipt or an ever-growing copied tree.
      expect(backing.fileCount()).toBe(403); // usage manifest + header + current envelope + 200 receipts + 200 live AVL nodes
      expect(backing.byteCount()).toBeLessThan(5 * 1024 * 1024);
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test("keeps reusable leaves through both AVL double rotations for warm and fresh replay lookup", async () => {
    const cases = [
      { label: "right-left", actionIds: ["ordinary-avl-right-left-a", "ordinary-avl-right-left-c", "ordinary-avl-right-left-b"] },
      { label: "left-right", actionIds: ["ordinary-avl-left-right-c", "ordinary-avl-left-right-a", "ordinary-avl-left-right-b"] },
    ];
    for (const { label, actionIds } of cases) {
      const root = mkdtempSync(join(tmpdir(), `ordinary-envelope-avl-${label}-`));
      const { session, initial } = fixture(`ordinary-avl-${label}`);
      try {
        const store = new OrdinarySessionSnapshotStore({ root });
        expect(store.save(initial)).toMatchObject({ status: "ok" });
        let current = await successor(store, session, initial, actionIds[0]!);
        expect(store.save(current)).toMatchObject({ status: "ok" });
        current = syntheticSuccessor(store, current, actionIds[1]!);
        expect(store.save(current)).toMatchObject({ status: "ok" });
        current = syntheticSuccessor(store, current, actionIds[2]!);
        expect(store.save(current)).toMatchObject({ status: "ok" });

        expect(store.read(initial.sessionId)).toMatchObject({ status: "ok", value: { generation: 3 } });
        for (const [index, actionId] of actionIds.entries()) {
          expect(store.findActionReceipt(initial.sessionId, actionId)).toMatchObject({ status: "ok", value: { actionId, generation: index + 1 } });
        }

        const restarted = new OrdinarySessionSnapshotStore({ root });
        expect(restarted.read(initial.sessionId)).toMatchObject({ status: "ok", value: { generation: 3 } });
        for (const [index, actionId] of actionIds.entries()) {
          expect(restarted.findActionReceipt(initial.sessionId, actionId)).toMatchObject({ status: "ok", value: { actionId, generation: index + 1 } });
        }
      } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
    }
  });

  test("uses only pre-pointer directory artifacts and fails closed if their authoritative root is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-directory-root-")); const { session, initial } = fixture("ordinary-directory-root");
    try {
      const store = new OrdinarySessionSnapshotStore({ root }); expect(store.save(initial)).toMatchObject({ status: "ok" });
      const first = await successor(store, session, initial, "ordinary-directory-action-0001"); expect(store.save(first)).toMatchObject({ status: "ok" });
      expect(readdirSync(root).filter((name) => name.includes("replay-locator")).length).toBe(0);
      expect(store.findActionReceipt(first.sessionId, "ordinary-directory-action-0001")).toMatchObject({ status: "ok", value: { generation: 1 } });
      unlinkSync(join(root, `${first.sessionId}.${first.replayDirectory.rootHash}.ordinary-action-replay-directory-node.json`));
      expect(store.read(first.sessionId)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CORRUPT" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("fails closed when an authenticated non-root replay node is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-directory-nonroot-")); const { session, initial } = fixture("ordinary-directory-nonroot");
    try {
      const store = new OrdinarySessionSnapshotStore({ root }); expect(store.save(initial)).toMatchObject({ status: "ok" });
      const first = await successor(store, session, initial, "ordinary-directory-nonroot-0001"); expect(store.save(first)).toMatchObject({ status: "ok" });
      const second = syntheticSuccessor(store, first, "ordinary-directory-nonroot-0002"); expect(store.save(second)).toMatchObject({ status: "ok" });
      const third = syntheticSuccessor(store, second, "ordinary-directory-nonroot-0003"); expect(store.save(third)).toMatchObject({ status: "ok" });
      const nodes = readdirSync(root).filter((name) => name.endsWith(".ordinary-action-replay-directory-node.json"));
      const rootName = `${third.sessionId}.${third.replayDirectory.rootHash}.ordinary-action-replay-directory-node.json`;
      const child = nodes.find((name) => name !== rootName);
      expect(child).toBeDefined();
      unlinkSync(join(root, child!));
      // A fresh-process/startup audit must detect an omitted subtree even
      // though normal cached reads remain logarithmic per action.
      expect(new OrdinarySessionSnapshotStore({ root }).audit(third.sessionId)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CORRUPT" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("caps each store's audited replay cache and cold-audits an evicted session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-cache-lru-"));
    const firstFixture = fixture("ordinary-cache-lru-first"); const secondFixture = fixture("ordinary-cache-lru-second");
    try {
      const store = new OrdinarySessionSnapshotStore({ root, maxAuditedReplaySets: 1 });
      expect(store.save(firstFixture.initial)).toMatchObject({ status: "ok" });
      const first = await successor(store, firstFixture.session, firstFixture.initial, "ordinary-cache-lru-0001"); expect(store.save(first)).toMatchObject({ status: "ok" });
      const second = syntheticSuccessor(store, first, "ordinary-cache-lru-0002"); expect(store.save(second)).toMatchObject({ status: "ok" });
      const third = syntheticSuccessor(store, second, "ordinary-cache-lru-0003"); expect(store.save(third)).toMatchObject({ status: "ok" });
      // Caching the second session evicts the first session's complete tree.
      expect(store.save(secondFixture.initial)).toMatchObject({ status: "ok" });
      const nodes = readdirSync(root).filter((name) => name.startsWith(`${third.sessionId}.`) && name.endsWith(".ordinary-action-replay-directory-node.json"));
      const rootName = `${third.sessionId}.${third.replayDirectory.rootHash}.ordinary-action-replay-directory-node.json`;
      const child = nodes.find((name) => name !== rootName); expect(child).toBeDefined();
      unlinkSync(join(root, child!));
      // An unbounded/retained cache would accept the current pointer after
      // checking only its root. Eviction forces a complete cold audit.
      expect(store.read(third.sessionId)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CORRUPT" });
    } finally { firstFixture.session.close(); secondFixture.session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("retries a lock-free reader that loses its predecessor directory path to a newer publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-directory-mvcc-")); const { session, initial } = fixture("ordinary-directory-mvcc");
    try {
      const writer = new OrdinarySessionSnapshotStore({ root }); expect(writer.save(initial)).toMatchObject({ status: "ok" });
      const first = await successor(writer, session, initial, "ordinary-mvcc-action-0001"); expect(writer.save(first)).toMatchObject({ status: "ok" });
      const second = syntheticSuccessor(writer, first, "ordinary-mvcc-action-0002");
      const predecessorRootPath = join(root, `${first.sessionId}.${first.replayDirectory.rootHash}.ordinary-action-replay-directory-node.json`);
      let advanced = false;
      const reader = new OrdinarySessionSnapshotStore({ root, fileOps: {
        ...compiledSessionSnapshotNodeFileOps,
        read(path, maxBytes) {
          if (!advanced && path === predecessorRootPath) {
            advanced = true;
            expect(writer.save(second)).toMatchObject({ status: "ok" });
          }
          return compiledSessionSnapshotNodeFileOps.read(path, maxBytes);
        },
      } });
      expect(reader.findActionReceipt(first.sessionId, "ordinary-mvcc-action-0001")).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(advanced).toBe(true);
      expect(reader.read(first.sessionId)).toMatchObject({ status: "ok", value: { generation: 2 } });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("fails closed for a tampered compact archive receipt and explicitly refuses pre-index schemas", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-envelope-archive-tamper-")); const { session, initial } = fixture("ordinary-archive-tamper");
    try {
      const store = new OrdinarySessionSnapshotStore({ root }); expect(store.save(initial)).toMatchObject({ status: "ok" });
      const next = await successor(store, session, initial, "ordinary-archive-action-0001"); expect(store.save(next)).toMatchObject({ status: "ok" });
      writeFileSync(join(root, `${next.sessionId}.${next.archive.headHash}.ordinary-action-receipt.json`), "{}\n");
      expect(store.read(next.sessionId)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CORRUPT" });
      const legacy = structuredClone(initial) as unknown as Record<string, unknown>;
      legacy.schemaVersion = "1.3.0";
      legacy.replayIndex = { count: 0, peaks: [] };
      expect(new OrdinarySessionSnapshotStore({ root: join(root, "legacy") }).save(legacy)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_INCOMPATIBLE" });
    } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
