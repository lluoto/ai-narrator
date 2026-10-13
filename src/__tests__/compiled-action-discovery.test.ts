import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, compiledMechanicsAction } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { handleRequest, runAction } from "../api/server";
import { createCompiledDurableTestHost, type CompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

interface DurableTestSession {
  readonly host: CompiledDurableTestHost;
  readonly session: GameSession;
}
const HIDDEN_FIXTURE_TEXT = ["父线索", "子线索", "一把档案室钥匙", "一份必须读懂的档案", "出口说明", "离开这里的旧车票", "rule_clean", "rule_hasty", "ending:rule_clean", "ending:rule_hasty"];
const rngIsolationChild = join(import.meta.dir, "compiled-action-discovery-rng-child.ts");
const RNG_ISOLATION_RESULT = "@@compiled-action-discovery-rng@@";
const RNG_ISOLATION_DEADLINE_MS = 15_000;

const keeperAuthenticator = () => ({ status: "authenticated" as const, principal: { id: "keeper:compiled-action-discovery", role: "keeper" as const } });

function root(): string {
  return mkdtempSync(join(tmpdir(), "compiled-actions-"));
}

async function isolatedContaminatedRngFixture(): Promise<{ snapshot: "ok"; httpSnapshot: "ok"; restoredContamination: boolean }> {
  const child = Bun.spawn([process.execPath, rngIsolationChild], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  let childExited = false;
  const exit = child.exited.then((code) => {
    childExited = true;
    return code;
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let primaryFailure: unknown;
  let failed = false;
  let fixture: { snapshot: "ok"; httpSnapshot: "ok"; restoredContamination: boolean } | undefined;
  const cleanupFailures = new Set<unknown>();
  try {
    const completion = Promise.all([exit, stdout, stderr]);
    const timedOut = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`isolated RNG fixture exceeded its ${RNG_ISOLATION_DEADLINE_MS}ms deadline`)), RNG_ISOLATION_DEADLINE_MS);
    });
    const [code, capturedStdout, capturedStderr] = await Promise.race([completion, timedOut]);
    if (code !== 0) throw new Error(`isolated RNG fixture failed (${code}): ${capturedStdout}\n${capturedStderr}`);
    const result = capturedStdout.split(/\r?\n/).find((line) => line.startsWith(RNG_ISOLATION_RESULT));
    if (!result) throw new Error(`isolated RNG fixture returned no result: ${capturedStdout}\n${capturedStderr}`);
    fixture = JSON.parse(result.slice(RNG_ISOLATION_RESULT.length)) as { snapshot: "ok"; httpSnapshot: "ok"; restoredContamination: boolean };
  } catch (error) {
    failed = true;
    primaryFailure = error;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    if (!childExited) {
      try {
        child.kill();
      } catch (error) {
        cleanupFailures.add(error);
      }
    }
    const settled = await Promise.allSettled([exit, stdout, stderr]);
    for (const outcome of settled) {
      if (outcome.status === "rejected" && outcome.reason !== primaryFailure) cleanupFailures.add(outcome.reason);
    }
  }
  if (failed) {
    if (cleanupFailures.size > 0) throw new AggregateError([primaryFailure, ...cleanupFailures], "isolated RNG fixture and cleanup failed");
    throw primaryFailure;
  }
  if (cleanupFailures.size === 1) throw cleanupFailures.values().next().value;
  if (cleanupFailures.size > 1) throw new AggregateError(cleanupFailures, "isolated RNG fixture cleanup failed");
  if (!fixture) throw new Error("isolated RNG fixture completed without a result");
  return fixture;
}

function methodIds(payload: any) {
  return {
    parent: payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id,
    child: payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_child")!.id,
    entry: payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "entry_archive")!.id,
    exit: payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "archive_exit")!.id,
  };
}

async function durableSession(
  dir: string,
  id = "compiled-actions",
) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const saved = saveTrustedFixtureBundle(catalog, fixture, "keeper:compiled-action-discovery");
  const bundle = catalog.loadBundle(saved.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  // Pure GameSession replay fixture: it intentionally exercises the
  // snapshot transaction below without the production HTTP namespace host.
  const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots"), allowUncoordinatedTestWrites: true });
  const host = createCompiledDurableTestHost();
  const session = new GameSession(
    id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") },
    undefined, "preferred", host.runtimeDependencies,
  );
  const loaded = session.loadDurableCompiledModule(bundle.value);
  if (loaded.status === "refused") throw new Error(loaded.message);
  const initial = host.snapshot(session);
  const stored = snapshots.save(initial);
  if (stored.status !== "ok") throw new Error(stored.message);
  host.acknowledge(session, initial);
  return { fixture, catalog, snapshots, session, durable: { host, session }, bundleId: saved.id, dir };
}

function restore(built: Awaited<ReturnType<typeof durableSession>>, snapshot?: unknown): DurableTestSession {
  const bundle = built.catalog.loadBundle(built.bundleId);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const raw = snapshot === undefined ? built.snapshots.read(built.session.id) : { status: "ok" as const, value: snapshot };
  if (raw.status !== "ok") throw new Error(raw.message);
  const host = createCompiledDurableTestHost();
  const session = new GameSession(
    built.session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(built.dir, "careers") },
    undefined, "preferred", host.runtimeDependencies,
  );
  const restored = session.restoreCompiledSession(raw.value, bundle.value);
  if (restored.status === "refused") throw new Error(restored.message);
  return { host, session };
}

function commitAndRestore(current: DurableTestSession, built: Awaited<ReturnType<typeof durableSession>>, mechanismId: string, actionId: string): DurableTestSession {
  const committed = current.host.commit(current.session, compiledMechanicsAction(mechanismId), actionId, current.session.getCompiledGeneration()!, (snapshot) => {
    const stored = built.snapshots.save(snapshot);
    if (stored.status !== "ok") throw new Error(stored.message);
  });
  if (committed.status !== "committed") throw new Error(`compiled action was not committed: ${committed.status}`);
  return restore(built, committed.snapshot);
}

async function httpSession(dir: string) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const saved = saveTrustedFixtureBundle(catalog, fixture, "keeper:compiled-action-discovery");
  const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots") });
  const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
  }), catalog, snapshots, { careerRoot: join(dir, "careers") }, {}, {}, keeperAuthenticator);
  if (response.status !== 201) throw new Error(await response.text());
  const created = await response.json() as { sessionId: string; generation: number };
  return { fixture, catalog, snapshots, sessionId: created.sessionId, creation: created, dir };
}

async function request(built: Awaited<ReturnType<typeof httpSession>>, path: string, method = "GET", body?: unknown) {
  const response = await handleRequest(new Request(`http://test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  }), built.catalog, built.snapshots, { careerRoot: join(built.dir, "careers") }, {}, {}, keeperAuthenticator);
  return { status: response.status, body: await response.json() as any };
}

async function listActions(built: Awaited<ReturnType<typeof httpSession>>) {
  return request(built, `/api/sessions/${built.sessionId}/compiled/actions?pcId=p1`);
}

async function structuredAction(built: Awaited<ReturnType<typeof httpSession>>, mechanismId: string, actionId: string, expectedGeneration: number) {
  return request(built, `/api/sessions/${built.sessionId}/compiled/actions`, "POST", { mechanismId, pcId: "p1", actionId, expectedGeneration });
}

/** Snapshot every public observation that action discovery/refusal must leave alone. */
function immutableCompiledView(session: GameSession) {
  return structuredClone({
    activePlayerId: session.activePlayerId,
    round: session.round,
    state: session.getState(),
    mechanicsState: session.getCompiledMechanicsState()?.state,
    trace: session.getCompiledMechanicsState()?.trace,
    world: session.world.getCurrentState(),
    history: session.getPlayerHistory("p1"),
    lastActiveAt: session.lastActiveAt,
  });
}

function expectPlayerSafeLabels(labels: string[]) {
  const text = labels.join("\n");
  for (const forbidden of HIDDEN_FIXTURE_TEXT) expect(text).not.toContain(forbidden);
}

describe("compiled action discovery", () => {
  it("constructs a durable fixture despite contaminated RNG in an isolated child process", async () => {
    const originalRandom = Math.random;
    expect(await isolatedContaminatedRngFixture()).toEqual({ snapshot: "ok", httpSnapshot: "ok", restoredContamination: true });
    expect(Math.random).toBe(originalRandom);
  }, 20_000);

  it("does not alter ordinary, Barn, or combat suggestion bytes", async () => {
    const ordinary = new GameSession("ordinary-suggestion-bytes", "cosmic-horror", CONFIG, "investigator", "Ada");
    expect(ordinary.getSuggestions("p1")).toEqual(["\u73af\u987e\u56db\u5468"]);

    const barn = new GameSession("barn-suggestion-bytes", "cosmic-horror", CONFIG, "investigator", "Ada");
    await barn.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
    expect(activateRegisteredGameSessionSceneForTest(barn, "\u7ef4\u68ee\u9152\u5427")).toBe(true);
    expect(barn.getSuggestions("p1")).toEqual([
      "\u4ed4\u7ec6\u641c\u67e5\u8fd9\u91cc", "\u4e0e \u9152\u5427\u4fdd\u9556 \u4ea4\u8c08", "\u4e0e \u524d\u53f0 \u4ea4\u8c08", "\u524d\u5f80 \u666e\u745e\u7c73\u5c14",
    ]);

    const originalRandom = Math.random;
    Math.random = () => 0.99;
    try {
      expect((await barn.act("攻击 酒吧保镖")).error).toBeUndefined();
    } finally {
      Math.random = originalRandom;
    }
    expect(barn.getSuggestions("p1")).toEqual([
      "\u2694\uFE0F \u653b\u51fb\u654c\u4eba", "\u{1F6E1}\uFE0F \u9632\u5fa1", "\u{1F48A} \u4f7f\u7528\u7269\u54c1", "\u{1F3C3} \u64a4\u9000",
    ]);
  });

  it("projects player-safe, deterministic, cloned actions from the shared available-action core", async () => {
    const fixture = await compiledModuleHttpFixture();
    const session = new GameSession("compiled-ephemeral", "cosmic-horror", CONFIG, "investigator", "Ada");
    const loaded = session.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection);
    expect(loaded.status).toBe("loaded");
    if (loaded.status === "refused") return;
    const actions = session.getCompiledAvailableActions();
    expect(actions.map((action) => action.mechanismId)).toEqual(["find_parent"]);
    expect(actions.every((action) => action.kind === "discovery" && action.label === "Search here" && action.command === compiledMechanicsAction(action.mechanismId))).toBe(true);
    expect(actions.every((action) => !("outcome" in action))).toBe(true);
    // These are real fixture-only data: clue display names, their source text,
    // and both terminal declarations. A generic prefix check would not catch
    // a future label that leaks one of them verbatim.
    expectPlayerSafeLabels(actions.map((action) => action.label));
    actions[0]!.label = "mutated";
    expect(session.getCompiledAvailableActions()[0]!.label).toBe("Search here");

    const result = await session.act(compiledMechanicsAction("find_parent"), "p1");
    expect(result.error).toBeUndefined();
    expect(session.getCompiledAvailableActions().map((action) => action.mechanismId)).not.toContain("find_parent");
  });

  it("never mutates a compiled session while listing real available actions", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "compiled-read-only");
      const before = immutableCompiledView(built.session);
      const first = built.session.getCompiledAvailableActions();
      const second = built.session.getCompiledAvailableActions();
      expect(second).toEqual(first);
      expect(immutableCompiledView(built.session)).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // This exercises HTTP creation, four durable commits, a snapshot reload, and
  // terminal refusal. Give this one end-to-end contract a local budget when a
  // saturated full suite delays its filesystem and HTTP work.
  it("serves generation-bound structured actions, refreshes after execution and restart, and preserves terminal metadata", async () => {
    const dir = root();
    const originalRandom = Math.random;
    try {
      const built = await httpSession(dir);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      expect(built.creation.generation).toBe(0);
      expect((await request(built, `/api/sessions/${built.sessionId}/state`)).body.generation).toBe(0);
      const initial = await listActions(built);
      expect(initial).toMatchObject({ status: 200, body: { generation: 0 } });
      expect(initial.body.actions.map((action: any) => action.mechanismId)).toEqual([ids.parent]);
      expect(initial.body.actions.map((action: any) => action.mechanismId)).not.toContain(ids.entry);

      const parent = await structuredAction(built, ids.parent, "parent", 0);
      expect(parent).toMatchObject({ status: 200, body: { generation: 1 } });
      const unlocked = await listActions(built);
      expect((await request(built, `/api/sessions/${built.sessionId}/state`)).body.generation).toBe(1);
      expect(unlocked.body.actions.map((action: any) => action.mechanismId)).toEqual([ids.entry]);
      expect(unlocked.body.actions[0]).toMatchObject({ kind: "traversal", command: compiledMechanicsAction(ids.entry) });
      expectPlayerSafeLabels(unlocked.body.actions.map((action: any) => action.label));

      const traversed = await structuredAction(built, ids.entry, "entry", 1);
      expect(traversed).toMatchObject({ status: 200, body: { generation: 2 } });
      const checked = await listActions(built);
      expect((await request(built, `/api/sessions/${built.sessionId}/state`)).body.generation).toBe(2);
      expect(checked.body.actions).toContainEqual(expect.objectContaining({ mechanismId: ids.child, kind: "discovery", label: "Read here", check: { kind: "skill", skill: "library_use", difficulty: "hard" } }));
      expect(checked.body.actions.every((action: any) => !("outcome" in action))).toBe(true);
      expectPlayerSafeLabels(checked.body.actions.map((action: any) => action.label));

      const raw = built.snapshots.read(built.sessionId);
      expect(raw.status).toBe("ok");
      if (raw.status !== "ok") return;
      const rawSnapshot = raw.value as { bundle: { id: string } };
      const bundle = built.catalog.loadBundle(rawSnapshot.bundle.id);
      expect(bundle.status).toBe("ok");
      if (bundle.status !== "ok") return;
      const restarted = new GameSession(built.sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") });
      expect(restarted.restoreCompiledSession(raw.value, bundle.value).status).toBe("loaded");
      expect(restarted.getCompiledAvailableActions()).toEqual(checked.body.actions);

      Math.random = () => 0;
      const child = await structuredAction(built, ids.child, "child", 2);
      expect(child).toMatchObject({ status: 200, body: { generation: 3 } });
      const exit = await listActions(built);
      expect((await request(built, `/api/sessions/${built.sessionId}/state`)).body.generation).toBe(3);
      expect(exit.body.actions.map((action: any) => action.mechanismId)).toEqual([ids.exit]);
      expect(await structuredAction(built, ids.exit, "exit", 3)).toMatchObject({ status: 200, body: { generation: 4 } });
      const terminal = await listActions(built);
      expect(terminal).toMatchObject({ status: 200, body: { generation: 4, actions: [], compiled: { terminalEnding: expect.any(Object) } } });
      expect(await structuredAction(built, ids.exit, "after-terminal", 4)).toMatchObject({ status: 409, body: { code: "compiled_terminal", generation: 4, compiled: { terminalEnding: expect.any(Object) } } });
      expect((await request(built, `/api/sessions/${built.sessionId}/state`)).body.generation).toBe(4);
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("uses p1's persisted check values and exposes one failback-capable mechanism without client outcomes", async () => {
    const dir = root();
    const originalRandom = Math.random;
    try {
      const built = await durableSession(dir, "compiled-checks");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      let current = commitAndRestore(built.durable, built, ids.parent, "parent");
      current = commitAndRestore(current, built, ids.entry, "entry");
      const persistedLibraryUse = current.session.activeCharacter?.skillValues?.library_use;
      if (typeof persistedLibraryUse !== "number") throw new Error("compiled fixture requires a persisted p1 library_use value");
      // Durable compiled membership is immutable: p2 never becomes a session
      // member. This non-member map record must not influence compiled p1
      // checks or history authority.
      expect(current.session.session.get("p2")).toBeUndefined();
      expect(current.session.session.getActive()?.name).toBe("p1");
      // A same-name public shadow is inert: ECMAScript private authority is
      // not observable or replaceable through the former TypeScript-private
      // field name.
      (current.session as unknown as { characters?: Map<string, unknown> }).characters = new Map([["p2", { name: "Stale", skillValues: { library_use: 1 } }]]);
      expect(current.session.session.get("p2")).toBeUndefined();
      expect(current.session.session.getActive()?.name).toBe("p1");
      Math.random = () => 0.99;
      const first = current.host.commit(current.session, compiledMechanicsAction(ids.child), "failure-one", 2, (snapshot) => {
        const stored = built.snapshots.save(snapshot);
        if (stored.status !== "ok") throw new Error(stored.message);
      });
      expect(first.status).toBe("committed");
      if (first.status !== "committed") return;
      const firstEvents = (first.response.action as unknown as { events: Array<{ content: string }> }).events;
      expect(first.snapshot?.character.pcId).toBe("p1");
      expect((first.snapshot?.history ?? []).map((message: any) => message.content)).toEqual(expect.arrayContaining(firstEvents.map((event) => event.content)));
      expect(firstEvents.some((event) => event.content.includes(`目标=${persistedLibraryUse}%`))).toBe(true);
      current = restore(built, first.snapshot);
      expect(current.session.activePlayerId).toBe("p1");
      expect(current.session.getPlayerHistory("p1").messages.map((message) => message.content)).toEqual(expect.arrayContaining(firstEvents.map((event) => event.content)));
      expect(current.session.getCompiledAvailableActions().filter((action) => action.mechanismId === ids.child)).toHaveLength(1);
      current = commitAndRestore(current, built, ids.child, "failure-two");
      expect(current.session.getCompiledAvailableActions().filter((action) => action.mechanismId === ids.child)).toHaveLength(1);
      const failback = current.host.commit(current.session, compiledMechanicsAction(ids.child), "failback", 4, (snapshot) => {
        const stored = built.snapshots.save(snapshot);
        if (stored.status !== "ok") throw new Error(stored.message);
      });
      expect(failback).toMatchObject({ status: "committed", response: { action: { compiled: { trace: expect.arrayContaining([expect.objectContaining({ mechanismId: ids.child, outcome: "failback" })]) } } } });
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps duplicate lookup ahead of availability and maps structured and codec refusals without mutation", async () => {
    const dir = root();
    try {
      const built = await httpSession(dir);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const before = await request(built, `/api/sessions/${built.sessionId}`);
      expect(await structuredAction(built, ids.child, "unavailable", 0)).toMatchObject({ status: 409, body: { code: "compiled_action_unavailable", generation: 0 } });
      expect(await structuredAction(built, "unknown_mechanism", "unknown", 0)).toMatchObject({ status: 409, body: { code: "compiled_action_unavailable", generation: 0 } });
      expect(await request(built, `/api/sessions/${built.sessionId}/compiled/actions`, "POST", { mechanismId: ids.parent, pcId: "p2", actionId: "unknown-pc", expectedGeneration: 0 })).toMatchObject({ status: 404, body: { code: "unknown_pc", generation: 0 } });
      expect(await request(built, `/api/sessions/${built.sessionId}/compiled/actions`, "POST", { pcId: "p1", actionId: "bad", expectedGeneration: 0 })).toMatchObject({ status: 400, body: { code: "compiled_action_contract_required" } });
      expect(await request(built, `/api/sessions/${built.sessionId}/compiled/actions`, "POST", { mechanismId: ids.parent, pcId: "p1", actionId: "client-outcome", expectedGeneration: 0, outcome: "failback" })).toMatchObject({ status: 400, body: { code: "compiled_action_contract_required", generation: 0 } });
      expect(await request(built, `/api/sessions/${built.sessionId}/action`, "POST", { input: "@compiled ", pcId: "p1", actionId: "bad-codec", expectedGeneration: 0 })).toMatchObject({ status: 400, body: { code: "compiled_action_required", generation: 0 } });
      expect(await request(built, `/api/sessions/${built.sessionId}`)).toEqual(before);

      const first = await structuredAction(built, ids.parent, "same-id", 0);
      expect(first.status).toBe(200);
      expect(await structuredAction(built, ids.parent, "same-id", 0)).toEqual(first);
      const afterFirst = await request(built, `/api/sessions/${built.sessionId}`);
      expect(await structuredAction(built, ids.entry, "stale", 0)).toMatchObject({ status: 409, body: { code: "compiled_generation_conflict", generation: 1 } });
      expect(await structuredAction(built, ids.entry, "same-id", 1)).toMatchObject({ status: 409, body: { code: "compiled_idempotency_conflict", generation: 1 } });
      expect(await request(built, `/api/sessions/${built.sessionId}`)).toEqual(afterFirst);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves mechanics, world mirrors, and p1 history unchanged for unknown and unavailable compiled IDs", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "compiled-refusal-no-write");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const before = immutableCompiledView(built.session);
      for (const [input, actionId] of [[compiledMechanicsAction(ids.child), "unavailable"], [compiledMechanicsAction("unknown_mechanism"), "unknown"]] as const) {
        expect(await runAction(built.session, { input, pcId: "p1", actionId, expectedGeneration: 0 }, () => { throw new Error("must not persist a refusal"); }, undefined, undefined, undefined, built.durable.host.capability)).toMatchObject({ status: 409, body: { code: "compiled_action_unavailable", generation: 0 } });
        expect(immutableCompiledView(built.session)).toEqual(before);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("maps a structured HTTP snapshot persistence refusal to 500", async () => {
    const dir = root();
    try {
      const built = await httpSession(dir);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const snapshots: any = built.snapshots;
      const originalSave = snapshots.save;
      snapshots.save = () => ({ status: "refused", code: "SNAPSHOT_IO", message: "forced test persistence refusal" });
      try {
        expect(await structuredAction(built, ids.parent, "persistence-http", 0)).toMatchObject({ status: 500, body: { code: "compiled_persistence_failed", generation: 0 } });
      } finally {
        snapshots.save = originalSave;
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps structured and legacy codec execution equivalent and makes compiled suggestions executable", async () => {
    const leftDir = root();
    const rightDir = root();
    try {
      const structured = await httpSession(leftDir);
      const codec = await httpSession(rightDir);
      const ids = methodIds(structured.fixture.resolved.artifact.payload);
      const structuredResult = await structuredAction(structured, ids.parent, "same", 0);
      const codecResult = await request(codec, `/api/sessions/${codec.sessionId}/action`, "POST", { input: compiledMechanicsAction(ids.parent), pcId: "p1", actionId: "same", expectedGeneration: 0 });
      expect(structuredResult.status).toBe(200);
      expect(codecResult.status).toBe(200);
      expect(structuredResult.body.compiled.stateHash).toBe(codecResult.body.compiled.stateHash);
      expect(structuredResult.body.compiled.trace).toEqual(codecResult.body.compiled.trace);
      const suggestions = await request(structured, `/api/sessions/${structured.sessionId}/suggestions?pcId=p1`);
      const actions = await listActions(structured);
      expect(suggestions.body.suggestions).toEqual(actions.body.actions.map((action: any) => action.command));

      const ordinary = new GameSession("ordinary-suggestions", "cosmic-horror", CONFIG, "investigator", "Ada");
      expect(ordinary.getSuggestions("p1")).toEqual(["环顾四周"]);
    } finally {
      rmSync(leftDir, { recursive: true, force: true });
      rmSync(rightDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("maps durable persistence failure and leaves public compiled refusal state unchanged", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "compiled-persist-failure");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      expect(await runAction(built.session, { input: compiledMechanicsAction(ids.parent), pcId: "p1", actionId: "fails", expectedGeneration: 0 }, () => { throw new Error("storage failed"); }, undefined, undefined, undefined, built.durable.host.capability)).toMatchObject({ status: 500, body: { code: "compiled_persistence_failed", generation: 0 } });
      const before = immutableCompiledView(built.session);
      expect(await runAction(built.session, { input: compiledMechanicsAction("unknown_mechanism"), pcId: "p1", actionId: "execution", expectedGeneration: 0 }, () => { throw new Error("must not persist an execution refusal"); }, undefined, undefined, undefined, built.durable.host.capability)).toMatchObject({ status: 409, body: { code: "compiled_action_unavailable", generation: 0 } });
      expect(immutableCompiledView(built.session)).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
