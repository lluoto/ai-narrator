import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CareerFileStore } from "../character/career-file";
import { ordinaryGameSessionSnapshotHash, validateOrdinaryGameSessionSnapshot } from "../api/ordinary-game-session-snapshot";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";

const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const auth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-career-projection-owner" } });

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
  return handleRequest(
    new Request(`http://test${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, dependencies,
  );
}

type DurableGrowthMark = { pcId: string; skills: string[] };
type DurableSkillSheet = { skillValues?: Record<string, number>; skills?: Record<string, number> };

function durableSkillSettlementState(snapshot: unknown): { marks: DurableGrowthMark[]; sheetFor: (pcId: string) => DurableSkillSheet } {
  if (!snapshot || typeof snapshot !== "object") throw new Error("durable settlement snapshot is unavailable");
  const state = (snapshot as { state?: unknown }).state;
  if (!state || typeof state !== "object") throw new Error("durable settlement state is unavailable");
  const record = state as Record<string, unknown>;
  if (!Array.isArray(record.skillGrowthMarksByPC) || !Array.isArray(record.characters)) {
    throw new Error("durable settlement fixture requires owner-aware growth marks");
  }
  const marks = record.skillGrowthMarksByPC.map((value): DurableGrowthMark => {
    if (!value || typeof value !== "object" || typeof (value as { pcId?: unknown }).pcId !== "string"
      || !Array.isArray((value as { skills?: unknown }).skills)
      || !(value as { skills: unknown[] }).skills.every((skill) => typeof skill === "string")) {
      throw new Error("durable settlement growth mark is invalid");
    }
    return { pcId: (value as { pcId: string }).pcId, skills: [...(value as { skills: string[] }).skills] };
  });
  const sheets = new Map<string, DurableSkillSheet>();
  for (const value of record.characters) {
    if (!value || typeof value !== "object") continue;
    const character = value as { pcId?: unknown; sheet?: unknown };
    if (typeof character.pcId !== "string" || !character.sheet || typeof character.sheet !== "object") continue;
    sheets.set(character.pcId, character.sheet as DurableSkillSheet);
  }
  return {
    marks,
    sheetFor(pcId) {
      const sheet = sheets.get(pcId);
      if (!sheet) throw new Error(`durable settlement fixture lacks character ${pcId}`);
      return sheet;
    },
  };
}

test("a directly loaded Premier package survives export and fresh restore with its installable static projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-premier-static-projection-"));
  const id = "ordinary_premier_static_projection";
  const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined,
    { careerRoot: join(root, "source") }, undefined, "development_fallback");
  const target = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
    { careerRoot: join(root, "target") }, undefined, "development_fallback");
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const snapshot = source.exportOrdinarySessionSnapshot();
    target.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(target.exportOrdinarySessionSnapshot().module).toEqual(snapshot.module);
    expect(target.getState()).toEqual(source.getState());
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rehashed Premier static-value forgery still fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-premier-static-forgery-"));
  const id = "ordinary_premier_static_forgery";
  const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined,
    { careerRoot: join(root, "source") }, undefined, "development_fallback");
  const target = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
    { careerRoot: join(root, "target") }, undefined, "development_fallback");
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const forged = structuredClone(source.exportOrdinarySessionSnapshot());
    forged.state.sceneBgm["特里坎家"] = "forged-static-bgm";
    const { snapshotHash: _discarded, ...unsigned } = forged;
    forged.snapshotHash = ordinaryGameSessionSnapshotHash(unsigned);
    expect(() => target.restoreOrdinarySessionSnapshot(forged)).toThrow("static state disagrees");
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a committed ordinary departure persists exactly one career ending across duplicate replay and fresh hydration", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-projection-http-"));
  const first = runtime();
  const restarted = runtime();
  try {
    const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json() as { sessionId: string };

    const load = { input: "加载模组 普瑞米尔的谷仓", actionId: "ordinary-career-load-0001", expectedGeneration: 0 };
    const leave = { input: "我们决定离开这里，结束这次调查", actionId: "ordinary-career-leave-0002", expectedGeneration: 1 };
    const confirm = { input: "确定", actionId: "ordinary-career-confirm-0003", expectedGeneration: 2 };
    const loaded = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, load);
    expect(loaded.status, await loaded.text()).toBe(200);
    expect((await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, leave)).status).toBe(200);
    const committed = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, confirm);
    expect(committed.status).toBe(200);
    expect((await committed.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(3);

    const store = new CareerFileStore(join(root, "careers", sessionId));
    const afterCommit = store.getEntries("Ada");
    expect(afterCommit).toHaveLength(1);
    expect(afterCommit[0]).toMatchObject({
      characterName: "Ada", moduleName: "普瑞米尔的谷仓", endingId: "normal", endingName: "Normal End",
    });

    const replay = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, confirm);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(store.getEntries("Ada")).toHaveLength(1);

    expect((await request(root, restarted.dependencies, `/api/sessions/${sessionId}`)).status).toBe(200);
    expect(new CareerFileStore(join(root, "careers", sessionId)).getEntries("Ada")).toHaveLength(1);
  } finally {
    for (const session of first.registry.values()) session.close();
    for (const session of restarted.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a departure career-entry failure cannot publish its candidate success, then the exact retry commits once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-departure-entry-fail-"));
  const first = runtime();
  const originalAddEntry = CareerFileStore.prototype.addEntry;
  let rejectConfirmationCandidate = false;
  CareerFileStore.prototype.addEntry = function (entry: Parameters<typeof originalAddEntry>[0]): void {
    if (rejectConfirmationCandidate) throw new Error("simulated departure career write failure");
    originalAddEntry.call(this, entry);
  };
  try {
    const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json() as { sessionId: string };
    const load = { input: "加载模组 普瑞米尔的谷仓", actionId: "ordinary-career-failure-load-0001", expectedGeneration: 0 };
    const leave = { input: "我们决定离开这里，结束这次调查", actionId: "ordinary-career-failure-leave-0002", expectedGeneration: 1 };
    const confirm = { input: "确定", actionId: "ordinary-career-failure-confirm-0003", expectedGeneration: 2 };
    expect((await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, load)).status).toBe(200);
    expect((await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, leave)).status).toBe(200);

    rejectConfirmationCandidate = true;
    const failed = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, confirm);
    expect(failed.status).toBe(500);
    const failedBody = await failed.json() as Record<string, unknown>;
    expect(failedBody).toMatchObject({ code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: 2 });
    expect(JSON.stringify(failedBody)).not.toContain("simulated departure career write failure");

    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const afterFailure = snapshots.read(sessionId);
    expect(afterFailure).toMatchObject({ status: "ok", value: { generation: 2 } });
    if (afterFailure.status !== "ok") throw new Error("failed departure must retain its durable predecessor");
    expect(afterFailure.value.snapshot.state.dead).toBe(false);
    expect(afterFailure.value.snapshot.state.pendingLeaveConfirm).toBe(true);
    expect(snapshots.findActionReceipt(sessionId, confirm.actionId)).toEqual({ status: "ok", value: null });
    const careers = new CareerFileStore(join(root, "careers", sessionId));
    expect(careers.getEntries("Ada")).toHaveLength(0);

    rejectConfirmationCandidate = false;
    const retried = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, confirm);
    expect(retried.status).toBe(200);
    expect((await retried.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(3);
    expect(careers.getEntries("Ada")).toHaveLength(1);
    const afterRetry = snapshots.read(sessionId);
    expect(afterRetry).toMatchObject({ status: "ok", value: { generation: 3 } });
    if (afterRetry.status !== "ok") throw new Error("retried departure must become durable");
    expect(afterRetry.value.snapshot.state.dead).toBe(false);
    expect(validateOrdinaryGameSessionSnapshot(afterRetry.value.snapshot).state.terminal).toMatchObject({ kind: "module_departure" });
    expect(afterRetry.value.snapshot.state.pendingLeaveConfirm).toBe(false);

    const duplicate = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, confirm);
    expect(duplicate.status).toBe(200);
    expect(duplicate.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(careers.getEntries("Ada")).toHaveLength(1);
  } finally {
    rejectConfirmationCandidate = false;
    CareerFileStore.prototype.addEntry = originalAddEntry;
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a confirmed departure career-entry failure leaves durable growth pending, then the exact confirmation retry settles once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-settlement-entry-fail-"));
  const first = runtime();
  const originalAddEntry = CareerFileStore.prototype.addEntry;
  const originalRandom = Math.random;
  let rejectSettlementCandidate = false;
  CareerFileStore.prototype.addEntry = function (entry: Parameters<typeof originalAddEntry>[0]): void {
    if (rejectSettlementCandidate) throw new Error("simulated settlement career write failure");
    originalAddEntry.call(this, entry);
  };
  try {
    const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json() as { sessionId: string };
    // The ordinary CoC mark belongs to a successful skill use.  Session
    // hydration may construct auxiliary state, so keep all pre-settlement
    // randomness at d100=1 rather than coupling this durable proof to its
    // incidental random-call count.
    Math.random = () => 0;
    const successfulCheck = { input: "调查", actionId: "ordinary-career-settlement-check-0001", expectedGeneration: 0 };
    const load = { input: "加载模组 普瑞米尔的谷仓", actionId: "ordinary-career-settlement-load-0002", expectedGeneration: 1 };
    const settlementRequest = { input: "模组结算", actionId: "ordinary-career-settlement-request-0003", expectedGeneration: 2 };
    const confirm = { input: "确定", actionId: "ordinary-career-settlement-confirm-0004", expectedGeneration: 3 };
    expect((await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, successfulCheck)).status).toBe(200);
    expect((await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, load)).status).toBe(200);

    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const beforeSettlement = snapshots.read(sessionId);
    expect(beforeSettlement.status).toBe("ok");
    if (beforeSettlement.status !== "ok") throw new Error("settlement fixture must be durably readable");
    const beforeState = durableSkillSettlementState(beforeSettlement.value.snapshot);
    const pendingMarks = structuredClone(beforeState.marks);
    const pendingSheet = structuredClone(beforeState.sheetFor("p1"));
    expect(pendingMarks).not.toEqual([]);
    const pendingSkill = pendingMarks.find((entry) => entry.pcId === "p1")?.skills[0];
    if (!pendingSkill) throw new Error("successful durable check must leave a p1 growth mark");
    const pendingSkillValue = pendingSheet?.skillValues?.[pendingSkill] ?? pendingSheet?.skills?.[pendingSkill];
    if (typeof pendingSkillValue !== "number") throw new Error("pending growth fixture requires a stored skill value");

    // Requesting settlement opens the departure confirmation but cannot roll
    // an advancement, clear pending growth, alter skill values, or create a
    // career entry. Candidate hydration may use ambient randomness while it
    // reconstructs private module helpers, so assert the durable dice/state
    // projection rather than process-global incidental calls.
    Math.random = () => 0.99;
    const requested = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, settlementRequest);
    expect(requested.status).toBe(200);
    const afterRequest = snapshots.read(sessionId);
    expect(afterRequest).toMatchObject({ status: "ok", value: { generation: 3 } });
    if (afterRequest.status !== "ok") throw new Error("settlement request must become durable");
    expect(afterRequest.value.snapshot.state.dead).toBe(false);
    expect(afterRequest.value.snapshot.state.pendingLeaveConfirm).toBe(true);
    expect(afterRequest.value.snapshot.state.lastDiceRoll).toEqual(beforeSettlement.value.snapshot.state.lastDiceRoll);
    expect(afterRequest.value.snapshot.state.lastRolls).toEqual(beforeSettlement.value.snapshot.state.lastRolls);
    const afterRequestState = durableSkillSettlementState(afterRequest.value.snapshot);
    expect(afterRequestState.marks).toEqual(pendingMarks);
    expect(afterRequestState.sheetFor("p1")).toEqual(pendingSheet);
    expect(snapshots.findActionReceipt(sessionId, confirm.actionId)).toEqual({ status: "ok", value: null });
    expect(new CareerFileStore(join(root, "careers", sessionId)).getEntries("Ada")).toHaveLength(0);

    // Confirmation needs d100 > current skill followed by +1d10. Candidate
    // rollback recreates auxiliary state, hence this is a value contract
    // rather than a global-call-count contract.
    Math.random = () => 0.99;
    rejectSettlementCandidate = true;
    const failed = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, confirm);
    expect(failed.status).toBe(500);
    const failedBody = await failed.json() as Record<string, unknown>;
    expect(failedBody).toMatchObject({ code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: 3 });
    expect(JSON.stringify(failedBody)).not.toContain("simulated settlement career write failure");

    const afterFailure = snapshots.read(sessionId);
    expect(afterFailure.status).toBe("ok");
    if (afterFailure.status !== "ok") throw new Error("failed settlement must retain its durable predecessor");
    expect(afterFailure.value.generation).toBe(3);
    expect(afterFailure.value.snapshot.state.dead).toBe(false);
    expect(afterFailure.value.snapshot.state.pendingLeaveConfirm).toBe(true);
    const afterFailureState = durableSkillSettlementState(afterFailure.value.snapshot);
    expect(afterFailureState.marks).toEqual(pendingMarks);
    expect(afterFailureState.sheetFor("p1")).toEqual(pendingSheet);
    expect(snapshots.findActionReceipt(sessionId, confirm.actionId)).toEqual({ status: "ok", value: null });
    const careers = new CareerFileStore(join(root, "careers", sessionId));
    expect(careers.getEntries("Ada")).toHaveLength(0);

    rejectSettlementCandidate = false;
    const retried = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, confirm);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await retried.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(4);
    expect(careers.getEntries("Ada")).toHaveLength(1);
    const afterRetry = snapshots.read(sessionId);
    expect(afterRetry).toMatchObject({ status: "ok", value: { generation: 4 } });
    if (afterRetry.status !== "ok") throw new Error("retried settlement must become durable");
    expect(afterRetry.value.snapshot.state.dead).toBe(false);
    expect(validateOrdinaryGameSessionSnapshot(afterRetry.value.snapshot).state.terminal).toMatchObject({ kind: "module_departure" });
    expect(afterRetry.value.snapshot.state.pendingLeaveConfirm).toBe(false);
    const afterRetryState = durableSkillSettlementState(afterRetry.value.snapshot);
    expect(afterRetryState.marks).toEqual([]);
    const settledSheet = afterRetryState.sheetFor("p1");
    expect(settledSheet?.skillValues?.[pendingSkill] ?? settledSheet?.skills?.[pendingSkill]).toBe(Math.min(99, pendingSkillValue + 10));

    const duplicate = await request(root, first.dependencies, `/api/sessions/${sessionId}/action`, confirm);
    expect(duplicate.status).toBe(200);
    expect(duplicate.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(careers.getEntries("Ada")).toHaveLength(1);
    const afterDuplicate = snapshots.read(sessionId);
    expect(afterDuplicate).toMatchObject({ status: "ok", value: { generation: 4 } });
    if (afterDuplicate.status !== "ok") throw new Error("duplicate settlement must retain durable successor");
    const duplicateSheet = durableSkillSettlementState(afterDuplicate.value.snapshot).sheetFor("p1");
    expect(duplicateSheet?.skillValues?.[pendingSkill] ?? duplicateSheet?.skills?.[pendingSkill]).toBe(Math.min(99, pendingSkillValue + 10));
  } finally {
    rejectSettlementCandidate = false;
    CareerFileStore.prototype.addEntry = originalAddEntry;
    Math.random = originalRandom;
    for (const session of first.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
