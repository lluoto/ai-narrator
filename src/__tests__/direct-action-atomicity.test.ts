import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";
import { runAction } from "../api/server";
import { NPCStore } from "../db";
import { newStatus } from "../rules/status-effects";
import { WorldStateManager } from "../state/world-state-manager";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const LLM = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};

function withFixedNow<T>(now: number, operation: () => T): T {
  const original = Date.now;
  Date.now = () => now;
  try {
    return operation();
  } finally {
    Date.now = original;
  }
}

const sessions: GameSession[] = [];
const worldPrototypeRestorers: Array<() => void> = [];
afterEach(() => {
  while (worldPrototypeRestorers.length > 0) worldPrototypeRestorers.pop()!();
  while (sessions.length > 0) sessions.pop()!.close();
});

const isolationChild = "src/__tests__/direct-session-npc-store-isolation-child.ts";

async function defaultStoreIsolationProof(dbPath: string): Promise<{ leaked: boolean; secondUsableAfterFirstClose: boolean }> {
  const child = Bun.spawn([process.execPath, isolationChild, dbPath], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`default NPC-store child failed (${exitCode}): ${stderr || stdout}`);
  const line = stdout.split(/\r?\n/).findLast(Boolean);
  if (!line) throw new Error("default NPC-store child emitted no result");
  return JSON.parse(line) as { leaked: boolean; secondUsableAfterFirstClose: boolean };
}

function patchWorldMethodForSession(
  session: GameSession,
  method: "setPlayerSanity" | "upsertEntity" | "restoreSnapshot",
  onTarget: (original: (...args: any[]) => unknown, receiver: WorldStateManager, args: any[]) => unknown,
): () => void {
  const restore = patchGameSessionWorldMethod(session, method, onTarget);
  worldPrototypeRestorers.push(restore);
  return restore;
}

function installLatePersistenceFailure(session: GameSession): void {
  patchWorldMethodForSession(session, "setPlayerSanity", () => {
    throw new Error("sanity persistence denied");
  });
}

function createFaultedSession(): GameSession {
  const session = new GameSession(
    `direct-action-atomicity-${Math.random()}`,
    "cosmic-horror",
    LLM,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "preferred",
    { careerEntryPersistence: "transient" },
  );
  sessions.push(session);
  // Prepare the turn-ticked NPC through the signed ordinary restore boundary
  // before installing the fault; the public world observation is read-only.
  restoreSignedOrdinaryWorld(session, LLM, (world) => world.upsertEntity({
    id: "bleeding-npc", name: "Bleeding NPC", type: "npc",
    hp: 10, maxHp: 10, ac: 10, status: [newStatus("bleeding")], position: "tavern",
  }));
  installLatePersistenceFailure(session);
  return session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

type Observed<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

function observe<T>(promise: Promise<T>): Promise<Observed<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

function expectClosedAction(result: Observed<unknown>): void {
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") throw new Error("the direct action unexpectedly fulfilled");
  expect(result.reason).toHaveProperty("message", "closed GameSession cannot accept actions");
}

describe("direct GameSession action failures", () => {
  test("closing during a blocked intent provider rejects the stale direct action and its queued follower", async () => {
    const firstProvider = deferred<string>();
    const providerStarted = deferred<void>();
    let providerCalls = 0;
    const session = withFixedNow(1, () => new GameSession(
      `direct-close-race-${Math.random()}`,
      "cosmic-horror",
      LLM,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sessionIntentClient: {
          chat: () => {
            providerCalls++;
            providerStarted.resolve();
            return firstProvider.promise;
          },
        },
      },
    ));
    sessions.push(session);
    // Public state intentionally omits the intra-period tick. Prime it to the
    // boundary so one illicit clock advance changes the observable period,
    // even if a regression leaves round untouched.
    await session.act("/help");
    await session.act("/help");
    const beforeTime = session.getState().gameTime;
    expect(beforeTime).toMatchObject({ day: 1, period: "morning" });
    // The constructor's fixed timestamp makes the post-provider mutation
    // assertion deterministic without a writable production timestamp seam.
    let stale: Promise<unknown> | undefined;
    let queued: Promise<unknown> | undefined;
    try {
      // This session-bound injected provider deliberately blocks the first
      // *intent* await, before actUnlocked can begin ordinary turn mutation.
      // The sentinel has no local command grammar
      // or deterministic protocol. It therefore enters the session-bound
      // injected provider before any ordinary turn or world mutation.
      stale = session.act("PLAYER_PRIVATE_TRACE_4a8d");
      queued = session.act("/roll 1d6");
      // Convert both early into non-rejecting observations. Once the stale
      // action releases FIFO, the closed follower may reject in that same
      // microtask turn; neither outcome may become an unobserved rejection.
      const staleObserved = observe(stale);
      const queuedObserved = observe(queued);
      await providerStarted.promise;

      // A pending intent provider is still a pre-turn phase. The closed
      // session cannot safely expose state after its world database is
      // released, so observe this public period boundary immediately before
      // close rather than reaching into a private clock after close.
      expect(session.getState().gameTime).toEqual(beforeTime);

      session.close();
      firstProvider.resolve(JSON.stringify({ action: "help" }));

      const [staleResult, queuedResult] = await settleWithin(
        Promise.all([staleObserved, queuedObserved]),
        "the stale and queued direct action rejections",
      );
      expectClosedAction(staleResult);
      expectClosedAction(queuedResult);
      // The provider wait was pre-turn. A close revokes dynamic session
      // reads, so the obsolete response is proven non-observable by the
      // closed-reader boundary rather than by inspecting a retired clock.
      expect(() => session.round).toThrow("closed GameSession cannot read session state");
      expect(() => session.getState()).toThrow("closed GameSession cannot read session state");
      // The post-provider lifecycle gate runs before dispatch, so no retry or
      // later narrative provider may be started by this retired action.
      expect(providerCalls).toBe(1);
    } finally {
      firstProvider.resolve(JSON.stringify({ action: "help" }));
      await Promise.allSettled([stale, queued].filter((pending): pending is Promise<unknown> => pending !== undefined));
    }
  }, 10_000);

  test("a rejected post-provider intent keeps the public clock at its pre-turn boundary", async () => {
    let providerCalls = 0;
    const session = new GameSession(
      `direct-invalid-clock-${Math.random()}`,
      "cosmic-horror",
      LLM,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "required",
      {
        sessionIntentClient: {
          chat: async () => {
            providerCalls++;
            return "not a valid ActionIntent JSON";
          },
        },
      },
    );
    sessions.push(session);

    // `GameTime.ticks` is purposefully snapshot-only. Two real local turns
    // place this public view at the three-tick boundary, where one accidental
    // clock-only write becomes an externally visible period change.
    await session.act("/help");
    await session.act("/help");
    const before = session.getState();
    expect(before.gameTime).toMatchObject({ day: 1, period: "morning" });

    const response = await session.act("MODEL_REPLY_MUST_BE_STRICT");

    expect(response.error).toEqual({ code: "intent_model_invalid", intentErrorCode: "intent_reply_invalid" });
    expect(providerCalls).toBe(1);
    expect(response.state.round).toBe(before.round);
    expect(response.state.gameTime).toEqual(before.gameTime);
    expect(session.round).toBe(before.round);
    expect(session.getState().gameTime).toEqual(before.gameTime);
  });

  test("late persistence failure fail-stops and closes a direct session", async () => {
    const session = createFaultedSession();

    await expect(session.act("/roll 1d6")).rejects.toThrow("sanity persistence denied");

    // Never read a closed world database to assert a fictional rollback. The
    // next action must instead get the stable unavailable contract.
    await expect(session.act("/roll 1d6")).rejects.toThrow(
      "GameSession is unavailable after a prior action failure",
    );
    expect(() => session.npcStore.getAllPersonalities()).toThrow();
  });

  test("runAction reports a stable generic direct failure without returning the session as live", async () => {
    const session = createFaultedSession();

    const result = await runAction(session, { input: "/roll 1d6" });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ code: "ordinary_execution_failed" });
    expect(JSON.stringify(result.body)).not.toContain("sanity persistence denied");
    expect(result.session).toBeUndefined();

    const retry = await runAction(session, { input: "/roll 1d6" });
    expect(retry.status).toBe(500);
    expect(retry.body).toEqual({ code: "ordinary_execution_failed" });
    expect(JSON.stringify(retry.body)).not.toContain("GameSession is unavailable after a prior action failure");
  });

  test("a queued direct action is rejected before it can run after its predecessor fail-stops", async () => {
    const session = createFaultedSession();
    const first = session.act("/roll 1d6");
    const queued = session.act("/roll 1d6");

    const [firstResult, queuedResult] = await Promise.allSettled([first, queued]);
    expect(firstResult).toMatchObject({ status: "rejected" });
    expect(queuedResult).toMatchObject({ status: "rejected" });
    if (firstResult.status !== "rejected" || queuedResult.status !== "rejected") {
      throw new Error("both queued direct actions must reject");
    }
    expect(firstResult.reason).toHaveProperty("message", "sanity persistence denied");
    expect(queuedResult.reason).toHaveProperty("message", "GameSession is unavailable after a prior action failure");
  });

  test("a fail-stopped session does not close a caller-owned shared NPC store", async () => {
    const sharedStore = new NPCStore(":memory:");
    const failed = new GameSession(`direct-shared-failed-${Math.random()}`, "cosmic-horror", LLM, undefined, undefined, undefined, undefined, undefined, undefined, { npcStore: sharedStore });
    const surviving = new GameSession(`direct-shared-surviving-${Math.random()}`, "cosmic-horror", LLM, undefined, undefined, undefined, undefined, undefined, undefined, { npcStore: sharedStore });
    sessions.push(failed, surviving);
    installLatePersistenceFailure(failed);

    try {
      await expect(failed.act("/roll 1d6")).rejects.toThrow("sanity persistence denied");
      await expect(failed.act("/roll 1d6")).rejects.toThrow(
        "GameSession is unavailable after a prior action failure",
      );

      expect((await surviving.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
      expect(surviving.npcStore.getAllPersonalities().length).toBeGreaterThan(0);
    } finally {
      failed.close();
      surviving.close();
      // The host retains ownership of an injected shared store.
      sharedStore.close();
    }
  });

  test("an ordinary direct action still commits its turn and history", async () => {
    const session = withFixedNow(1, () => new GameSession(`direct-action-commits-${Math.random()}`, "cosmic-horror", LLM));
    sessions.push(session);
    const beforeRound = session.round;
    const beforeHistory = session.getHistory().total;

    const result = await session.act("/roll 1d6");

    expect(result.error).toBeUndefined();
    expect(session.round).toBe(beforeRound + 1);
    expect(session.getHistory().total).toBeGreaterThan(beforeHistory);
    expect(session.lastActiveAt).toBeGreaterThan(1);
  });

  test("compensates a rejected late-party entity install and keeps p2 reusable", async () => {
    const root = mkdtempSync(join(tmpdir(), "direct-party-install-compensation-"));
    const session = new GameSession(`direct-party-install-${Math.random()}`, "cosmic-horror", LLM, "investigator", "Ada", undefined, { careerRoot: root });
    sessions.push(session);
    try {
      const beforeFaultWorld = session.world.exportSnapshot();
      const restoreEntityFailure = patchWorldMethodForSession(session, "upsertEntity", (original, receiver, args) => {
        if ((args[0] as { id?: unknown } | undefined)?.id === "p2") {
          throw new Error("party entity rejected");
        }
        return original.apply(receiver, args);
      });

      expect(() => session.addPartyMember("Bea", "investigator")).toThrow("party entity rejected");
      expect(session.world.getEntity("p2")).toBeNull();
      expect(session.world.getPlayerSanity("p2")).toBeNull();
      expect(session.world.getPlayerState("p2")).toBeNull();
      expect(session.world.exportSnapshot()).toEqual(beforeFaultWorld);
      expect(session.session.get("p2")).toBeUndefined();
      const snapshot = session.exportOrdinarySessionSnapshot();
      expect(snapshot.state.characters.some((entry) => entry.pcId === "p2")).toBe(false);
      expect(snapshot.state.sanities.some((entry) => entry.pcId === "p2")).toBe(false);
      expect(snapshot.state.party.some((entry) => entry.pcId === "p2")).toBe(false);

      restoreEntityFailure();
      const retried = session.addPartyMember("Bea", "investigator");
      expect(retried).not.toHaveProperty("rejected");
      if ("rejected" in retried) throw new Error("compensated p2 should be reusable");
      expect(retried.member.pcId).toBe("p2");
      await expect(session.act("/roll 1d6")).resolves.toMatchObject({ state: { round: 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fail-stops when a late-party component compensation cannot complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "direct-party-compensation-failstop-"));
    const session = new GameSession(`direct-party-compensation-${Math.random()}`, "cosmic-horror", LLM, "investigator", "Ada", undefined, { careerRoot: root });
    sessions.push(session);
    try {
      patchWorldMethodForSession(session, "upsertEntity", (original, receiver, args) => {
        if ((args[0] as { id?: unknown } | undefined)?.id === "p2") {
          throw new Error("party entity rejected");
        }
        return original.apply(receiver, args);
      });
      patchWorldMethodForSession(session, "restoreSnapshot", () => {
        throw new Error("party compensation rejected");
      });

      expect(() => session.addPartyMember("Bea", "investigator")).toThrow("party entity rejected");
      await expect(session.act("/roll 1d6")).rejects.toThrow(
        "GameSession is unavailable after a prior action failure",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("default direct-session NPC store isolation", () => {
  test("separate child process proves default stores do not reuse the configured shared database", async () => {
    const root = mkdtempSync(join(tmpdir(), "direct-session-npc-store-"));
    try {
      const proof = await defaultStoreIsolationProof(join(root, "would-be-shared.db"));
      expect(proof).toEqual({
        leaked: false,
        secondUsableAfterFirstClose: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default stores isolate module NPC persistence and closing one leaves the other usable", async () => {
    const first = new GameSession(`direct-npc-first-${Math.random()}`, "cosmic-horror", LLM);
    const second = new GameSession(`direct-npc-second-${Math.random()}`, "cosmic-horror", LLM);
    sessions.push(first, second);

    expect((await first.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect(first.npcStore.getAllPersonalities().length).toBeGreaterThan(0);
    expect(second.npcStore.getAllPersonalities()).toEqual([]);
    expect((await second.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect(second.npcStore.getAllPersonalities().length).toBeGreaterThan(0);

    first.close();
    expect(second.npcStore.getAllPersonalities().length).toBeGreaterThan(0);
  });
});
