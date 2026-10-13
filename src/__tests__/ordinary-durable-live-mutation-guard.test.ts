import { expect, it } from "bun:test";
import * as gameSessionApi from "../api/game-session";
import {
  GameSession,
  OrdinaryDurableMutationError,
  acknowledgeOrdinaryDurableIdentity,
  runOrdinaryDurableActionTransaction,
  type OrdinarySessionDurableIdentity,
} from "../api/game-session";
import { ordinaryGameSessionBusinessStateHash } from "../api/ordinary-game-session-snapshot";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const durableHostCapability = Object.freeze(Object.create(null)) as object;
const terminalTestLlm = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
};

function durableIdentity(): OrdinarySessionDurableIdentity {
  return {
    generation: 3,
    envelopeHash: "a".repeat(64),
    snapshotHash: `sha256:${"b".repeat(64)}`,
  };
}

function durableLive(): GameSession {
  const session = new GameSession(
    "ordinary-durable-live-mutation-guard",
    "cosmic-horror",
    undefined,
    "detective",
    "Ada",
    undefined,
    undefined,
    createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-durable-live-owner" }),
    "development_fallback",
    { ordinaryDurableHostCapability: durableHostCapability },
  );
  acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, durableIdentity());
  return session;
}

function expectDurableWriteRejected(write: () => unknown): void {
  expect(write).toThrow(OrdinaryDurableMutationError);
  expect(write).toThrow("ordinary_durable_transaction_required");
}

it("rejects every ordinary public live write after durable identity acknowledgement without changing the durable view", async () => {
  const session = durableLive();
  try {
    const before = session.exportOrdinarySessionSnapshot();
    const historyBefore = session.getHistory();
    const identityBefore = session.getOrdinaryDurableIdentity();

    expectDurableWriteRejected(() => session.addMessage("KP", "blocked"));
    expectDurableWriteRejected(() => session.sendMessage("KP", "blocked"));
    expectDurableWriteRejected(() => session.addPartyMember("Bob", "detective"));
    expectDurableWriteRejected(() => session.updateActiveCharacter({ luck: 50 }));
    expectDurableWriteRejected(() => session.updateCharacter("p1", { luck: 50 }));
    expectDurableWriteRejected(() => session.spendActiveCharacterLuck(1));
    expectDurableWriteRejected(() => session.spendCharacterLuck("p1", 1));
    expectDurableWriteRejected(() => session.setPlayerInventory("p1", ["blocked"]));
    expectDurableWriteRejected(() => session.setPlayerWeapons("p1", ["blocked"]));
    expectDurableWriteRejected(() => session.setPlayerSan("p1", 1));
    expectDurableWriteRejected(() => session.setPlayerHp("p1", 1));
    expectDurableWriteRejected(() => session.applyDamage("p1", 1));
    expect(Reflect.get(session, "setScene")).toBeUndefined();
    expectDurableWriteRejected(() => session.setDifficulty("hard"));
    expectDurableWriteRejected(() => session.loadCompiledModule({} as never, {} as never));
    expectDurableWriteRejected(() => session.loadDurableCompiledModule({} as never));
    expectDurableWriteRejected(() => session.restoreCompiledSession({} as never, {} as never));

    await expect(session.getOpeningScene()).rejects.toBeInstanceOf(OrdinaryDurableMutationError);
    await expect(session.act("investigate")).rejects.toBeInstanceOf(OrdinaryDurableMutationError);
    await expect(session.runExclusiveActionTransaction(async (act) => act("investigate"))).rejects.toBeInstanceOf(OrdinaryDurableMutationError);

    expect(session.exportOrdinarySessionSnapshot()).toEqual(before);
    expect(session.exportOrdinarySessionSnapshot().snapshotHash).toBe(before.snapshotHash);
    expect(session.getHistory()).toEqual(historyBefore);
    expect(session.getOrdinaryDurableIdentity()).toEqual(identityBefore);
  } finally {
    expect(() => session.close()).not.toThrow();
  }
});

it("does not let an untrusted caller acknowledge a durable ordinary identity", () => {
  const session = new GameSession("ordinary-durable-identity-untrusted", "cosmic-horror", undefined, "detective", "Ada");
  try {
    expect(gameSessionApi).not.toHaveProperty("bindOrdinaryDurableHostCapability");
    expect(() => acknowledgeOrdinaryDurableIdentity(session, Object.freeze(Object.create(null)), durableIdentity()))
      .toThrow("ordinary durable identity requires the durable host capability");
    expect(session.getOrdinaryDurableIdentity()).toBeNull();
  } finally {
    session.close();
  }
});

it("allows only idempotent durable identity acknowledgement for the same host capability", () => {
  const session = durableLive();
  try {
    const first = durableIdentity();
    const before = session.exportOrdinarySessionSnapshot();
    const historyBefore = session.getHistory();

    // A transport retry for the exact publish is harmless and must not alter
    // the current live authority.
    expect(() => acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, first)).not.toThrow();
    expect(session.getOrdinaryDurableIdentity()).toEqual(first);

    for (const conflicting of [
      { ...first, generation: first.generation + 1 },
      { ...first, envelopeHash: "c".repeat(64) },
      { ...first, snapshotHash: `sha256:${"d".repeat(64)}` },
    ]) {
      expect(() => acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, conflicting))
        .toThrow("ordinary durable identity is already installed");
    }
    expect(session.getOrdinaryDurableIdentity()).toEqual(first);
    expect(session.exportOrdinarySessionSnapshot()).toEqual(before);
    expect(session.getHistory()).toEqual(historyBefore);
  } finally {
    session.close();
  }
});

it("keeps the durable snapshot unchanged even when a caller attempts a direct post-ack message write", () => {
  const session = durableLive();
  try {
    const before = session.exportOrdinarySessionSnapshot();
    try { session.addMessage("KP", "must not enter durable live history"); } catch (error) {
      expect(error).toBeInstanceOf(OrdinaryDurableMutationError);
    }
    expect(session.exportOrdinarySessionSnapshot()).toEqual(before);
    expect(session.getHistory().total).toBe(0);
  } finally {
    session.close();
  }
});

it("does not poison the durable host transaction after direct act is policy-rejected", async () => {
  const session = durableLive();
  try {
    const before = session.exportOrdinarySessionSnapshot();
    await expect(session.act("investigate")).rejects.toBeInstanceOf(OrdinaryDurableMutationError);

    const captured = await runOrdinaryDurableActionTransaction(
      session,
      durableHostCapability,
      async (_act, snapshotBeforeAction) => snapshotBeforeAction(),
    );
    expect(captured).toEqual(before);
    expect(session.exportOrdinarySessionSnapshot()).toEqual(before);
    expect(session.getOrdinaryDurableIdentity()).toEqual(durableIdentity());
  } finally {
    session.close();
  }
});

it("projects an acknowledged ordinary terminal without exposing the durable live authority", async () => {
  const source = new GameSession(
    "ordinary-durable-terminal-projection",
    "cosmic-horror",
    undefined,
    "detective",
    "Ada",
    undefined,
    undefined,
    createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-durable-terminal-owner" }),
    "development_fallback",
    { ordinaryDurableHostCapability: durableHostCapability },
  );
  const session = new GameSession(
    "ordinary-durable-terminal-projection",
    "cosmic-horror",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-durable-terminal-owner" }),
    "development_fallback",
    { ordinaryDurableHostCapability: durableHostCapability, careerEntryPersistence: "transient" },
  );
  try {
    session.restoreOrdinarySessionSnapshot(source.exportOrdinarySessionSnapshot());
    await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
    await session.act("\u6211\u4eec\u51b3\u5b9a\u79bb\u5f00\u8fd9\u91cc\uff0c\u7ed3\u675f\u8fd9\u6b21\u8c03\u67e5");
    const departure = await session.act("\u786e\u5b9a");
    if (departure.terminal?.kind !== "module_departure") throw new Error("expected an ordinary module departure");

    // Preserve actual module-departure terminal behaviour before acknowledging
    // a durable identity.  `dead` must remain the compatibility view, while
    // terminality itself blocks later ordinary input.
    const departureRound = departure.state.round;
    const blocked = await session.act("observe");
    expect(blocked).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    expect(blocked.state.round).toBe(departureRound);

    const before = session.exportOrdinarySessionSnapshot();
    const businessHashBefore = ordinaryGameSessionBusinessStateHash(before);
    const identity = {
      generation: 4,
      envelopeHash: "c".repeat(64),
      snapshotHash: before.snapshotHash,
    };
    acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, identity);

    const getterTerminal = session.getOrdinaryTerminal();
    const secondGetterTerminal = session.getOrdinaryTerminal();
    const responseTerminal = departure.terminal;
    if (getterTerminal?.kind !== "module_departure" || secondGetterTerminal?.kind !== "module_departure") {
      throw new Error("expected ordinary terminal projections");
    }

    // Every public observation must be a detached projection.  In particular,
    // the retained ActionResponse predates acknowledgement, so it cannot become
    // a write capability into the now durable live object.
    expect(getterTerminal).not.toBe(secondGetterTerminal);
    expect(getterTerminal).not.toBe(responseTerminal);
    expect(Object.isFrozen(getterTerminal)).toBe(true);
    expect(Object.isFrozen(responseTerminal)).toBe(true);

    expect(Reflect.set(getterTerminal as any, "endingId", "forged-ending-id")).toBe(false);
    expect(Reflect.set(getterTerminal as any, "endingName", "forged ending name")).toBe(false);
    expect(Reflect.set(getterTerminal as any, "kind", "death")).toBe(false);
    expect(Reflect.deleteProperty(getterTerminal as any, "endingName")).toBe(false);
    expect(Reflect.set(responseTerminal as any, "endingName", "forged durable response ending")).toBe(false);
    expect(Reflect.deleteProperty(responseTerminal as any, "endingId")).toBe(false);

    expect(session.getOrdinaryTerminal()).toEqual(secondGetterTerminal);
    expect(session.dead).toBe(false);
    const after = session.exportOrdinarySessionSnapshot();
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect(ordinaryGameSessionBusinessStateHash(after)).toBe(businessHashBefore);
    expect(session.getOrdinaryDurableIdentity()).toEqual(identity);
  } finally {
    source.close();
    session.close();
  }
});

it("keeps a real death terminal blocking ordinary input after terminal projection hardening", async () => {
  let session = new GameSession(
    "ordinary-terminal-projection-real-death",
    "cosmic-horror",
    terminalTestLlm,
    "detective",
    "Ada",
  );
  const originalRandom = Math.random;
  try {
    const prepared = new GameSession(session.id, "cosmic-horror", terminalTestLlm);
    try {
      restoreSignedOrdinaryWorld(prepared, terminalTestLlm, (world) => {
        const scene = world.getCurrentState().scene;
        world.upsertEntity({
          id: "terminal-projection-death-monster", name: "terminal projection death monster", type: "monster",
          hp: 200, maxHp: 200, ac: 0, status: [], position: scene, scene_id: scene,
        });
      }, session);
    } catch (error) {
      prepared.close();
      throw error;
    }
    session.close();
    session = prepared;
    expect(session.setPlayerHp("p1", 1)).toMatchObject({ ok: true });
    const values = [0, 0, 0.99, 0, 0, 0.99, 0, 0, 0, 0.99, 0.99];
    let index = 0;
    Math.random = () => values[index++] ?? 0.99;

    const death = await session.act("\u653b\u51fb terminal projection death monster");
    const roundAtDeath = death.state.round;
    expect(death).toMatchObject({ dead: true, terminal: { kind: "death" } });
    expect(Object.isFrozen(death.terminal)).toBe(true);
    const blocked = await session.act("observe");
    expect(blocked).toMatchObject({ dead: true, terminal: { kind: "death" } });
    expect(blocked.state.round).toBe(roundAtDeath);
    expect(blocked.events[0]?.content).toContain("\u4f60\u5df2\u7ecf\u6b7b\u4e86");
  } finally {
    Math.random = originalRandom;
    session.close();
  }
});

it("projects retained action dice without exposing acknowledged durable live state", async () => {
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-durable-dice-owner" });
  let source = new GameSession(
    "ordinary-durable-dice-projection",
    "cosmic-horror",
    terminalTestLlm,
    "detective",
    "Ada",
    undefined,
    undefined,
    access,
    "development_fallback",
  );
  let session = new GameSession(
    source.id,
    "cosmic-horror",
    terminalTestLlm,
    undefined,
    undefined,
    undefined,
    undefined,
    access,
    "development_fallback",
    { ordinaryDurableHostCapability: durableHostCapability },
  );
  try {
    restoreSignedOrdinaryWorld(session, terminalTestLlm, (world) => {
      const scene = world.getCurrentState().scene;
      world.upsertEntity({
        id: "durable-dice-projection-monster", name: "durable dice projection monster", type: "monster",
        hp: 200, maxHp: 200, ac: 0, status: [], position: scene, scene_id: scene,
      });
    }, source);
    source.close();
    const response = await session.act("\u653b\u51fb durable dice projection monster");
    const dice = response.dice;
    const roll = dice?.[0];
    if (!roll) throw new Error("expected a real ordinary attack dice roll");

    const before = session.exportOrdinarySessionSnapshot();
    const businessHashBefore = ordinaryGameSessionBusinessStateHash(before);
    const identity = {
      generation: 5,
      envelopeHash: "d".repeat(64),
      snapshotHash: before.snapshotHash,
    };
    acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, identity);

    // The current dice schema has scalar fields only.  Freeze both the outer
    // array and detached roll object, and reject grafting a nested graph so a
    // future nested field cannot turn a retained response into a write path.
    const forgedNested = { entries: [{ total: 987654 }] };
    expect(Object.isFrozen(dice)).toBe(true);
    expect(Object.isFrozen(roll)).toBe(true);
    expect(Reflect.set(roll as any, "total", 987654)).toBe(false);
    expect(Reflect.set(roll as any, "nested", forgedNested)).toBe(false);
    expect(Reflect.deleteProperty(roll as any, "expr")).toBe(false);
    expect(Reflect.set(dice as any, 0, forgedNested)).toBe(false);
    expect(Reflect.set(dice as any, "nested", forgedNested)).toBe(false);
    expect(Reflect.deleteProperty(dice as any, 0)).toBe(false);

    const after = session.exportOrdinarySessionSnapshot();
    expect(after.state.lastDiceRoll).toEqual(before.state.lastDiceRoll);
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect(ordinaryGameSessionBusinessStateHash(after)).toBe(businessHashBefore);
    expect(session.getOrdinaryDurableIdentity()).toEqual(identity);
  } finally {
    try { source.close(); } catch { /* source is closed after restore */ }
    session.close();
  }
});

it("rejects a public ordinary snapshot restore on an acknowledged but otherwise pristine target", () => {
  const id = "ordinary-durable-pristine-restore-guard";
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-durable-restore-owner" });
  const source = new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined, undefined, access, "development_fallback");
  const target = new GameSession(
    id,
    "cosmic-horror",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    access,
    "development_fallback",
    { ordinaryDurableHostCapability: durableHostCapability },
  );
  try {
    // A normal, identity-null source may prepare a portable replacement state.
    // It differs from the target solely by an ordinary history entry, so the
    // old bypass demonstrably changed live state while retaining its identity.
    source.addMessage("KP", "replacement state must not install");
    const replacement = source.exportOrdinarySessionSnapshot();
    acknowledgeOrdinaryDurableIdentity(target, durableHostCapability, {
      ...durableIdentity(),
      snapshotHash: replacement.snapshotHash,
    });
    const before = target.exportOrdinarySessionSnapshot();
    const historyBefore = target.getHistory();
    const identityBefore = target.getOrdinaryDurableIdentity();

    let rejection: unknown;
    try { target.restoreOrdinarySessionSnapshot(replacement); }
    catch (error) { rejection = error; }

    // Keep the state assertion first: with the guard removed this is a real
    // successful restore and reports the history/snapshot drift, not merely a
    // missing error type.
    expect(target.exportOrdinarySessionSnapshot()).toEqual(before);
    expect(target.getHistory()).toEqual(historyBefore);
    expect(target.getOrdinaryDurableIdentity()).toEqual(identityBefore);
    expect(rejection).toBeInstanceOf(OrdinaryDurableMutationError);
    expect(rejection).toMatchObject({ code: "ordinary_durable_transaction_required" });
  } finally {
    source.close();
    target.close();
  }
});
