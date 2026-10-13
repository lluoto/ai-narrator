import { existsSync, readFileSync, readdirSync, writeSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { validateOrdinaryGameSessionSnapshot } from "../api/ordinary-game-session-snapshot";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { handleRequest, hydrateOrdinarySession, reconcileRuntimeSessionNamespace, type SessionRuntimeDependencies } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { CareerFileStore, careerPortableProjectionHash } from "../character/career-file";

const PREFIX = "@@ordinary-career-kill@@";
const SESSION_ID = "12345678-1234-4123-8123-123456789abc";
const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const authenticator: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-career-kill-owner" } });

function emit(value: Record<string, unknown>): void {
  writeSync(1, `${PREFIX}${JSON.stringify(value)}\n`);
}

function pause(): void {
  // A pipe read and Atomics.wait can return immediately in Bun's Windows
  // child harness. This synchronous sleep keeps the child exactly at the
  // durable marker until the parent force-terminates it.
  Bun.sleepSync(60_000);
}

function storage(root: string) {
  return { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
}

function runtime(
  root: string,
  onOrdinaryPublicationStage?: (stage: "dirty-persisted" | "first-artifact-persisted" | "pointer-durable-before-clean") => void,
): SessionRuntimeDependencies {
  const registry = new Map<string, GameSession>();
  return {
    registry,
    ordinaryIntentPolicy: "development_fallback",
    generateSessionId: () => SESSION_ID,
    ordinarySnapshots: new OrdinarySessionSnapshotStore({
      root: join(root, "sessions", "ordinary-snapshots"),
      ...(onOrdinaryPublicationStage ? { testHooks: { onPublicationStage: onOrdinaryPublicationStage } } : {}),
    }),
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage: sessionStorage, access, intentPolicy, runtimeDependencies }) => {
      const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, sessionStorage, access, intentPolicy, runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
    createOrdinaryRecoverySession: ({ id, storage: sessionStorage, access, intentPolicy, runtimeDependencies }) => {
      const session = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, sessionStorage, access, intentPolicy, runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
  };
}

async function request(root: string, dependencies: SessionRuntimeDependencies, path: string, body?: unknown): Promise<Response> {
  return handleRequest(
    new Request(`http://ordinary-career-kill${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    undefined, undefined, storage(root), {}, {}, authenticator,
    undefined, undefined, undefined, { mode: "required" }, dependencies,
  );
}

async function crash(root: string, phase: "before-projection-completion" | "during-retired-unlink" | "after-staged-leaf-before-journal" | "before-ordinary-cas" | "after-ordinary-cas" | "after-career-pointer" | "before-namespace-commit"): Promise<void> {
  const prototype = CareerFileStore.prototype as unknown as {
    prepareOrdinaryProjectionCommit: (...args: any[]) => unknown;
    writeOrdinaryProjectionCommitRecord: (...args: any[]) => unknown;
    resolveOrdinaryProjectionCommit: (...args: any[]) => unknown;
    deleteRootControlFile: (name: string) => unknown;
    atomicWriteRootControlFile: (name: string, text: string, maximumBytes?: number) => unknown;
    unlinkRetiredProjectionLeaf: (leaf: string) => unknown;
  };
  let armedCareerFault = false;
  let retiredOrphan: string | null = null;
  let retiredOrphanWasComplete = false;
  let retiredOrphanWasUnprotected = false;
  const authoritativeCareerDirectory = resolve(root, "careers", SESSION_ID);
  const isAuthoritativeCareerDirectory = (directory: string): boolean => {
    const left = resolve(directory); const right = authoritativeCareerDirectory;
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  };
  if (phase === "before-projection-completion") {
    const original = prototype.atomicWriteRootControlFile;
    prototype.atomicWriteRootControlFile = function (this: CareerFileStore, name: string, text: string, maximumBytes?: number): unknown {
      const baseDir = (this as unknown as { baseDir: string }).baseDir;
      if (armedCareerFault && name === ".career-complete.json" && basename(baseDir).startsWith("building-")
        && isAuthoritativeCareerDirectory(dirname(dirname(baseDir)))) {
        const careerDirectory = dirname(dirname(baseDir));
        const pointer = existsSync(join(careerDirectory, ".career-active.json"))
          ? JSON.parse(readFileSync(join(careerDirectory, ".career-active.json"), "utf8")) as { active?: unknown }
          : null;
        emit({
          event: "fault-point", phase, stage: "projection-leaves-durable-before-completion", sessionId: SESSION_ID,
          building: basename(baseDir), completion: existsSync(join(baseDir, ".career-complete.json")),
          rootLock: existsSync(join(careerDirectory, ".career-root.lock")), directory: baseDir,
          authoritativeRoot: authoritativeCareerDirectory, finalRoot: true, staging: baseDir.includes(".ordinary-action-staging"),
          activePointer: typeof pointer?.active === "string" ? pointer.active : null,
          journal: existsSync(join(careerDirectory, ".ordinary-career-projection-commit.json")),
        });
        pause();
      }
      return original.call(this, name, text, maximumBytes);
    };
  } else if (phase === "during-retired-unlink") {
    const original = prototype.unlinkRetiredProjectionLeaf;
    let unlinked = 0;
    prototype.unlinkRetiredProjectionLeaf = function (this: CareerFileStore, leaf: string): unknown {
      const retiredDirectory = dirname(leaf);
      const careerDirectory = dirname(dirname(retiredDirectory));
      const result = original.call(this, leaf);
      if (armedCareerFault && isAuthoritativeCareerDirectory(careerDirectory) && ++unlinked === 1) {
        const pointer = existsSync(join(careerDirectory, ".career-active.json"))
          ? JSON.parse(readFileSync(join(careerDirectory, ".career-active.json"), "utf8")) as { active?: unknown }
          : null;
        emit({
          event: "fault-point", phase, stage: "retired-stage-partially-unlinked", sessionId: SESSION_ID,
          retired: basename(retiredDirectory), remainingLeaves: readdirSync(retiredDirectory).length,
          rootLock: existsSync(join(careerDirectory, ".career-root.lock")),
          orphan: retiredOrphan, orphanWasComplete: retiredOrphanWasComplete, orphanWasUnprotected: retiredOrphanWasUnprotected,
          authoritativeRoot: authoritativeCareerDirectory, finalRoot: true, staging: retiredDirectory.includes(".ordinary-action-staging"),
          activePointer: typeof pointer?.active === "string" ? pointer.active : null,
          journal: existsSync(join(careerDirectory, ".ordinary-career-projection-commit.json")),
        });
        pause();
      }
      return result;
    };
  } else if (phase === "after-staged-leaf-before-journal") {
    const original = prototype.writeOrdinaryProjectionCommitRecord;
    prototype.writeOrdinaryProjectionCommitRecord = function (this: CareerFileStore, ...args: any[]): unknown {
      const baseDir = (this as unknown as { baseDir: string }).baseDir;
      const versions = join(baseDir, ".career-projections");
      emit({
        event: "fault-point", phase, stage: "staged-leaf-durable-before-journal", sessionId: SESSION_ID,
        stagedLeaf: existsSync(versions) && readdirSync(versions).some((name) => name.startsWith("projection-")),
        journal: existsSync(join(baseDir, ".ordinary-career-projection-commit.json")),
        rootLock: existsSync(join(baseDir, ".career-root.lock")),
      });
      pause();
      return original.apply(this, args);
    };
  } else if (phase === "before-ordinary-cas") {
    const original = prototype.prepareOrdinaryProjectionCommit;
    prototype.prepareOrdinaryProjectionCommit = function (this: CareerFileStore, ...args: any[]): unknown {
      const prepared = original.apply(this, args);
      const successor = (prepared as { successor?: { version?: unknown } }).successor;
      const baseDir = (this as unknown as { baseDir: string }).baseDir;
      emit({
        event: "fault-point", phase, stage: "journal-durable-before-ordinary-cas", sessionId: SESSION_ID,
        journal: existsSync(join(baseDir, ".ordinary-career-projection-commit.json")),
        stagedLeaf: typeof successor?.version === "string" && existsSync(join(baseDir, ".career-projections", successor.version)),
      });
      pause();
      return prepared;
    };
  } else if (phase === "after-ordinary-cas") {
    const original = prototype.resolveOrdinaryProjectionCommit;
    prototype.resolveOrdinaryProjectionCommit = function (this: CareerFileStore, ...args: any[]): unknown {
      if (args[1] === "successor") {
        const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
        const envelope = snapshots.read(SESSION_ID);
        const namespace = new SessionNamespaceCoordinator(join(root, "sessions")).read(SESSION_ID);
        emit({
          event: "fault-point", phase, stage: "ordinary-and-namespace-durable-before-career-finalize", sessionId: SESSION_ID,
          ordinaryGeneration: envelope.status === "ok" ? envelope.value.generation : null,
          namespaceGeneration: namespace?.expectedIdentity?.generation ?? null,
        });
        pause();
      }
      return original.apply(this, args);
    };
  } else if (phase === "after-career-pointer") {
    const original = prototype.deleteRootControlFile;
    prototype.deleteRootControlFile = function (this: CareerFileStore, name: string): unknown {
      if (name === ".ordinary-career-projection-commit.json") {
        const active = join((this as unknown as { baseDir: string }).baseDir, ".career-active.json");
        if (existsSync(active)) {
          const baseDir = (this as unknown as { baseDir: string }).baseDir;
          emit({
            event: "fault-point", phase, stage: "career-pointer-durable-before-journal-cleanup", sessionId: SESSION_ID,
            journal: existsSync(join(baseDir, ".ordinary-career-projection-commit.json")),
            rootLock: existsSync(join(baseDir, ".career-root.lock")),
            pointer: JSON.parse(readFileSync(active, "utf8")),
          });
          pause();
        }
      }
      return original.call(this, name);
    };
  }

  let armedNamespaceFault = false;
  const dependencies = runtime(root, phase === "before-namespace-commit" ? (stage) => {
    if (!armedNamespaceFault || stage !== "pointer-durable-before-clean") return;
    const snapshots = dependencies.ordinarySnapshots!;
    const envelope = snapshots.read(SESSION_ID);
    if (envelope.status !== "ok") throw new Error("ordinary envelope is unavailable at namespace crash fault point");
    const snapshot = validateOrdinaryGameSessionSnapshot(envelope.value.snapshot);
    if (snapshot.career.mode !== "complete") throw new Error("ordinary envelope lacks a complete Career successor");
    const careerDirectory = join(root, "careers", SESSION_ID);
    const pointer = JSON.parse(readFileSync(join(careerDirectory, ".career-active.json"), "utf8")) as { active?: unknown };
    const journal = JSON.parse(readFileSync(join(careerDirectory, ".ordinary-career-projection-commit.json"), "utf8")) as {
      predecessor?: { version?: unknown };
      successor?: { version?: unknown };
    };
    emit({
      event: "fault-point", phase, stage: "ordinary-pointer-durable-before-namespace-commit", sessionId: SESSION_ID,
      ordinaryGeneration: envelope.value.generation,
      journal: true,
      pointerStillPredecessor: pointer.active === journal.predecessor?.version,
      stagedSuccessorDiffers: journal.predecessor?.version !== journal.successor?.version,
    });
    pause();
  } : undefined);
  const created = await request(root, dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
  if (created.status !== 201) throw new Error(`ordinary Career kill fixture create failed: ${created.status}`);
  armedNamespaceFault = true;
  if (phase === "before-projection-completion" || phase === "during-retired-unlink") {
    // This child invokes the same final-root prepare primitive that the
    // ordinary server transaction reaches after candidate derivation. It
    // intentionally does not acquire the separate ordinary-action admission
    // lease, so this is a Career-writer crash regression plus a later HTTP
    // composition check, not a full server-request process-kill test.
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const envelope = snapshots.read(SESSION_ID);
    if (envelope.status !== "ok") throw new Error("Career writer child lacks its ordinary predecessor envelope");
    const snapshot = validateOrdinaryGameSessionSnapshot(envelope.value.snapshot);
    if (snapshot.career.mode !== "complete") throw new Error("Career writer child lacks a complete predecessor projection");
    const career = new CareerFileStore(authoritativeCareerDirectory);
    const predecessor = career.capturePortableProjectionIdentity();
    if (phase === "during-retired-unlink") {
      // The controlled stage primitive writes and verifies a fully complete
      // unreferenced projection; it never fabricates a partial authority.
      const internal = career as unknown as {
        withRootWriteLock<T>(operation: () => T): T;
        stagePortableProjection(projection: ReturnType<CareerFileStore["exportPortableProjection"]>): { version: string; projectionHash: string };
      };
      const currentProjection = career.exportPortableProjection();
      const orphanIdentity = internal.withRootWriteLock(() => internal.stagePortableProjection(currentProjection));
      retiredOrphan = orphanIdentity.version;
      retiredOrphanWasComplete = true;
      const pointer = JSON.parse(readFileSync(join(authoritativeCareerDirectory, ".career-active.json"), "utf8")) as { active?: unknown };
      retiredOrphanWasUnprotected = pointer.active !== orphanIdentity.version
        && !existsSync(join(authoritativeCareerDirectory, ".ordinary-career-projection-commit.json"));
      if (!retiredOrphanWasComplete || !retiredOrphanWasUnprotected) {
        throw new Error("ordinary Career retired fixture did not establish a complete unprotected orphan");
      }
    }
    armedCareerFault = true;
    career.prepareOrdinaryProjectionCommit({
      sessionId: SESSION_ID,
      predecessorGeneration: envelope.value.generation,
      predecessorEnvelopeHash: envelope.value.envelopeHash,
      generation: envelope.value.generation + 1,
      envelopeHash: "c".repeat(64),
      predecessor,
    }, snapshot.career.projection);
    throw new Error("Career writer child unexpectedly prepared its ordinary projection commit");
  }
  armedCareerFault = true;
  const action = await request(root, dependencies, `/api/sessions/${SESSION_ID}/action`, {
    input: "调查", actionId: `ordinary-career-kill-${phase}`, expectedGeneration: 0,
  });
  throw new Error(`ordinary Career kill fixture unexpectedly returned ${action.status}`);
}

async function recover(root: string, runNextOrdinaryAction = false): Promise<void> {
  const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
  const careerDirectory = join(root, "careers", SESSION_ID);
  const pointerBeforeHydrate = existsSync(join(careerDirectory, ".career-active.json"))
    ? readFileSync(join(careerDirectory, ".career-active.json"), "utf8")
    : null;
  const envelopeBeforeHydrate = snapshots.read(SESSION_ID);
  const result = hydrateOrdinarySession(SESSION_ID, {
    snapshots,
    sessionNamespace: new SessionNamespaceCoordinator(join(root, "sessions")),
    storage: storage(root),
    createSession: (id, access, runtimeDependencies) => {
      const session = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage(root), access, "development_fallback", runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
  });
  const envelope = snapshots.read(SESSION_ID);
  const lock = join(careerDirectory, ".career-root.lock");
  const journal = join(careerDirectory, ".ordinary-career-projection-commit.json");
  const pointer = join(careerDirectory, ".career-active.json");
  const namespace = new SessionNamespaceCoordinator(join(root, "sessions")).read(SESSION_ID);
  const snapshotCareerHash = envelope.status === "ok"
    ? (() => {
      const snapshot = validateOrdinaryGameSessionSnapshot(envelope.value.snapshot);
      return snapshot.career.mode === "complete" ? careerPortableProjectionHash(snapshot.career.projection) : null;
    })()
    : null;
  let careerProjectionHash: string | null = null;
  if (!existsSync(lock)) {
    try { careerProjectionHash = careerPortableProjectionHash(new CareerFileStore(careerDirectory).exportPortableProjection()); }
    catch { /* The recovery result remains the authority; diagnostics stay bounded. */ }
  }
  const body = result.status === "ok"
    ? { status: "ok", generation: result.envelope.generation }
    : { status: result.status, code: result.code, message: result.message };
  let hydratedIdentityPreserved: boolean | null = null;
  let nextOrdinaryActionStatus: number | null = null;
  let nextOrdinaryActionBody: unknown = null;
  let postActionGeneration: number | null = null;
  if (result.status === "ok" && runNextOrdinaryAction) {
    const pointerAfterHydrate = existsSync(pointer) ? readFileSync(pointer, "utf8") : null;
    const envelopeAfterHydrate = snapshots.read(SESSION_ID);
    hydratedIdentityPreserved = pointerBeforeHydrate === pointerAfterHydrate
      && envelopeBeforeHydrate.status === "ok"
      && envelopeAfterHydrate.status === "ok"
      && envelopeBeforeHydrate.value.envelopeHash === envelopeAfterHydrate.value.envelopeHash
      && envelopeBeforeHydrate.value.generation === envelopeAfterHydrate.value.generation;
    const dependencies = runtime(root);
    dependencies.registry?.set(SESSION_ID, result.session);
    const action = await request(root, dependencies, `/api/sessions/${SESSION_ID}/action`, {
      input: "璋冩煡", actionId: "ordinary-career-kill-recovery-action", expectedGeneration: result.envelope.generation,
    });
    nextOrdinaryActionStatus = action.status;
    try { nextOrdinaryActionBody = await action.json(); } catch { /* diagnostic stays optional */ }
    const afterAction = snapshots.read(SESSION_ID);
    postActionGeneration = afterAction.status === "ok" ? afterAction.value.generation : null;
    for (const session of dependencies.registry?.values() ?? []) session.close();
  } else if (result.status === "ok") {
    result.session.close();
  }
  emit({
    event: "recovered",
    ...body,
    envelopeGeneration: envelope.status === "ok" ? envelope.value.generation : null,
    namespaceGeneration: namespace?.expectedIdentity?.generation ?? null,
    journal: existsSync(journal),
    lock: existsSync(lock),
    pointer: existsSync(pointer) ? JSON.parse(readFileSync(pointer, "utf8")) : null,
    snapshotCareerHash,
    careerProjectionHash,
    hydratedIdentityPreserved,
    nextOrdinaryActionStatus,
    nextOrdinaryActionBody,
    postActionGeneration,
  });
}

async function recoverAfterNamespaceReconcile(root: string): Promise<void> {
  const sessionStorage = storage(root);
  const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
  const compiledSnapshots = new CompiledSessionSnapshotStore({ root: join(root, "sessions", "compiled-snapshots") });
  const namespace = new SessionNamespaceCoordinator(sessionStorage.sessionRoot);
  const registry = new Map<string, GameSession>();
  const createSession = (id: string, access: NonNullable<ConstructorParameters<typeof GameSession>[7]>, runtimeDependencies: NonNullable<ConstructorParameters<typeof GameSession>[9]>) => {
    const session = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, sessionStorage, access, "development_fallback", runtimeDependencies);
    session.getOpeningScene = async () => "opening";
    return session;
  };
  const envelope = ordinarySnapshots.read(SESSION_ID);
  if (envelope.status !== "ok") throw new Error("ordinary namespace recovery lacks its durable envelope");
  const snapshot = validateOrdinaryGameSessionSnapshot(envelope.value.snapshot);
  if (snapshot.career.mode !== "complete") throw new Error("ordinary namespace recovery lacks Career successor");
  const careerDirectory = join(root, "careers", SESSION_ID);
  const before = hydrateOrdinarySession(SESSION_ID, { snapshots: ordinarySnapshots, sessionNamespace: namespace, storage: sessionStorage, createSession });
  if (before.status === "ok") before.session.close();
  const beforePointer = JSON.parse(readFileSync(join(careerDirectory, ".career-active.json"), "utf8")) as { active?: unknown };
  const beforeJournal = JSON.parse(readFileSync(join(careerDirectory, ".ordinary-career-projection-commit.json"), "utf8")) as { predecessor?: { version?: unknown } };
  const beforeNamespace = namespace.read(SESSION_ID);
  reconcileRuntimeSessionNamespace(namespace, ordinarySnapshots, compiledSnapshots, sessionStorage);
  const afterNamespace = namespace.read(SESSION_ID);
  const dependencies: SessionRuntimeDependencies = {
    registry,
    ordinarySnapshots,
    sessionNamespace: namespace,
    ordinaryIntentPolicy: "development_fallback",
    createOrdinaryRecoverySession: ({ id, access, storage: recoveryStorage, intentPolicy, runtimeDependencies }) => {
      const session = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, recoveryStorage, access, intentPolicy, runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
  };
  const response = await request(root, dependencies, `/api/sessions/${SESSION_ID}`);
  const afterCareerHash = careerPortableProjectionHash(new CareerFileStore(careerDirectory).exportPortableProjection());
  emit({
    event: "namespace-reconciled",
    beforeHydrate: before.status === "ok" ? "ok" : before.code,
    beforeNamespaceGeneration: beforeNamespace?.expectedIdentity?.generation ?? null,
    beforeCareerStillPredecessor: beforePointer.active === beforeJournal.predecessor?.version,
    beforeRegistrySize: 0,
    afterNamespaceGeneration: afterNamespace?.expectedIdentity?.generation ?? null,
    httpStatus: response.status,
    registrySize: registry.size,
    careerMatchesEnvelope: afterCareerHash === careerPortableProjectionHash(snapshot.career.projection),
    journal: existsSync(join(careerDirectory, ".ordinary-career-projection-commit.json")),
  });
  for (const session of registry.values()) session.close();
}

if (import.meta.main) {
  const [mode, root] = process.argv.slice(2);
  try {
    if (!root || (mode !== "before-projection-completion" && mode !== "during-retired-unlink" && mode !== "after-staged-leaf-before-journal" && mode !== "before-ordinary-cas" && mode !== "after-ordinary-cas" && mode !== "after-career-pointer" && mode !== "before-namespace-commit" && mode !== "recover" && mode !== "recover-and-act" && mode !== "recover-after-namespace-reconcile")) {
      throw new Error("ordinary Career kill child requires a valid phase and root");
    }
    if (mode === "recover") await recover(root);
    else if (mode === "recover-and-act") await recover(root, true);
    else if (mode === "recover-after-namespace-reconcile") await recoverAfterNamespaceReconcile(root);
    else await crash(root, mode);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
