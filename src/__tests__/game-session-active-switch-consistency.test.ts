import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import type { NormalSessionIntentClient } from "../llm/intent";
import { SanityEngine } from "../rules/coc-engine";

const CONFIG = {
  apiKey: "sk-active-switch-consistency",
  baseUrl: "http://active-switch-consistency.invalid/v1",
  model: "active-switch-consistency",
  maxTokens: 32,
  temperature: 0,
};

function makeTwoPlayerSession(
  intentPolicy: "preferred" | "required" = "preferred",
  sessionIntentClient?: NormalSessionIntentClient,
): any {
  const game: any = new GameSession(
    `active-switch-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    "investigator",
    "p1",
    undefined,
    undefined,
    undefined,
    intentPolicy,
    sessionIntentClient ? { sessionIntentClient } : {},
  );
  const added = game.addPartyMember("p2", "investigator");
  if ("rejected" in added) throw new Error(`could not create p2: ${added.rejected}`);
  expect(game.activePlayerId).toBe("p1");
  expect(game.session.getActive()?.name).toBe("p1");
  return game;
}

function captureUnchangedActionState(game: any) {
  return {
    round: game.round,
    gameTime: structuredClone(game.getState().gameTime),
    world: game.world.exportSnapshot(),
    sanity: structuredClone(game.exportOrdinarySessionSnapshot().state.sanities),
    playerSession: game.session.exportSnapshot(),
    globalHistory: game.session.getRecentGlobal(1000),
    p1History: game.session.getPlayerHistory("p1"),
    p2History: game.session.getPlayerHistory("p2"),
    lastActiveAt: game.lastActiveAt,
    activePlayerId: game.activePlayerId,
    activeCharacter: structuredClone(game.activeCharacter),
    sanityRef: game.sanity,
    sessionActive: game.session.getActive()?.name,
  };
}

function expectUnchangedActionState(game: any, before: ReturnType<typeof captureUnchangedActionState>) {
  expect(game.round).toBe(before.round);
  expect(game.getState().gameTime).toEqual(before.gameTime);
  expect(game.world.exportSnapshot()).toEqual(before.world);
  expect(game.exportOrdinarySessionSnapshot().state.sanities).toEqual(before.sanity);
  expect(game.session.exportSnapshot()).toEqual(before.playerSession);
  expect(game.session.getRecentGlobal(1000)).toEqual(before.globalHistory);
  expect(game.session.getPlayerHistory("p1")).toEqual(before.p1History);
  expect(game.session.getPlayerHistory("p2")).toEqual(before.p2History);
  expect(game.lastActiveAt).toBe(before.lastActiveAt);
  expect(game.activePlayerId).toBe(before.activePlayerId);
  expect(game.activeCharacter).toEqual(before.activeCharacter);
  expect(game.sanity).toBe(before.sanityRef);
  expect(game.session.getActive()?.name).toBe(before.sessionActive);
}

function resolvedHelpIntentClient(): NormalSessionIntentClient {
  return {
    chat: async () => JSON.stringify({ action: "help" }),
  };
}

/**
 * The direct action response, public state, history routing, and ordinary
 * snapshot must all identify the same post-switch actor cohort.  This is
 * deliberately observation-only: no test seam reads the private maps.
 */
function expectCanonicalP2Actor(game: any, response: any, p2 = "p2"): void {
  const snapshot = game.exportOrdinarySessionSnapshot();
  const p2Character = snapshot.state.characters.find((entry: any) => entry.pcId === p2)?.sheet;
  const p2Sanity = snapshot.state.sanities.find((entry: any) => entry.pcId === p2)?.state;
  const p2Party = game.getState().party.find((entry: any) => entry.pcId === p2);

  expect(p2Character).toBeDefined();
  expect(p2Sanity).toBeDefined();
  expect(game.activePlayerId).toBe(p2);
  expect(game.session.getActive()?.name).toBe(p2);
  expect(game.activeCharacter).toEqual(p2Character);
  expect(game.sanity.state).toEqual(p2Sanity);
  expect(game.getSanity()).toMatchObject({ currentSAN: p2Sanity.currentSAN, maxSAN: p2Sanity.maxSAN });
  expect(p2Party).toMatchObject({ san: p2Sanity.currentSAN, maxSan: p2Sanity.maxSAN });
  expect(snapshot.state).toMatchObject({ activePlayerId: p2, activeCharacterId: p2 });
  expect(response.error).toBeUndefined();
  expect(response.state.round).toBe(game.round);
  expect(response.state.player.name).toBe(p2Character.name);
  expect(response.state.party.find((entry: any) => entry.pcId === p2)).toMatchObject({ san: p2Sanity.currentSAN });
  expect(response.sanity).toMatchObject({ currentSAN: p2Sanity.currentSAN, maxSAN: p2Sanity.maxSAN });
  expect(game.getHistory().total).toBe(game.session.getPlayerHistory(p2).length);
}

describe("ordinary direct-act active-player cohort", () => {
  it("keeps SAN cohort maps runtime-private and treats same-name external maps as inert shadows", async () => {
    const game = makeTwoPlayerSession();
    const beforeSnapshot = game.exportOrdinarySessionSnapshot();
    const beforeSanity = structuredClone(game.sanity.state);
    const beforeActive = game.activePlayerId;
    const fakeP1 = new SanityEngine(97);
    const fakeP2 = new SanityEngine(13);
    const fakeSanityEngines = new Map<string, SanityEngine>([["p1", fakeP1], ["p2", fakeP2]]);
    const fakeParty = new Map<string, { pcId: string; san: SanityEngine }>([
      ["p1", { pcId: "p1", san: fakeP1 }],
      ["p2", { pcId: "p2", san: fakeP2 }],
    ]);

    expect(Object.getOwnPropertyNames(game)).not.toContain("sanityEngines");
    expect(Object.getOwnPropertyNames(game)).not.toContain("party");
    expect(Reflect.ownKeys(game)).not.toContain("sanityEngines");
    expect(Reflect.ownKeys(game)).not.toContain("party");
    expect((game as any).sanityEngines).toBeUndefined();
    expect((game as any).party).toBeUndefined();

    // JavaScript callers can still add same-name public fields, but those
    // fields must neither reveal nor replace the session's private authority.
    (game as any).sanityEngines = fakeSanityEngines;
    (game as any).party = fakeParty;
    expect((game as any).sanityEngines).toBe(fakeSanityEngines);
    expect((game as any).party).toBe(fakeParty);
    fakeP1.restoreState({ ...fakeP1.state, currentSAN: 1 });
    fakeParty.set("p3", { pcId: "p3", san: new SanityEngine(1) });

    expect(game.exportOrdinarySessionSnapshot()).toEqual(beforeSnapshot);
    expect(game.sanity.state).toEqual(beforeSanity);
    expect(game.activePlayerId).toBe(beforeActive);
    expect(game.session.getActive()?.name).toBe(beforeActive);

    const nextP1San = beforeSanity.currentSAN > 0 ? beforeSanity.currentSAN - 1 : beforeSanity.maxSAN;
    expect(game.setPlayerSan("p1", nextP1San)).toMatchObject({ ok: true });
    expect(game.sanity.state.currentSAN).toBe(nextP1San);
    expect(fakeP1.state.currentSAN).toBe(1);

    const action = await game.act("/roll 1d6", "p2");
    expect(action.error).toBeUndefined();
    expect(game.activePlayerId).toBe("p2");
    expect(game.session.getActive()?.name).toBe("p2");
    expect(game.sanity.state).not.toEqual(fakeP2.state);
    expect(game.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === "p2")?.state)
      .not.toEqual(fakeP2.state);
  });

  it("exposes a frozen dynamic PlayerSession read facade without mutator authority", () => {
    const game = makeTwoPlayerSession();
    const facade: any = game.session;
    const semanticBefore = facade.semanticRevision;
    const replacementBefore = facade.stateReplacementRevision;

    expect(Object.isFrozen(facade)).toBe(true);
    for (const method of [
      "get", "getActive", "getAll", "getAllNames", "snapshot", "exportSnapshot",
      "getPlayerHistory", "getActiveHistory", "getRecentGlobal", "knowsSecret",
      "getPlayerScene", "getPlayersInScene",
    ]) expect(typeof facade[method]).toBe("function");
    for (const mutator of [
      "join", "leave", "switchActive", "restoreSnapshot", "restoreSinglePlayer",
      "push", "pushPerPlayer", "discover",
    ]) expect(facade[mutator]).toBeUndefined();

    expect(facade.count).toBe(2);
    expect(facade.get("p2")?.characterId).toBe("p2");
    expect(facade.getActive()?.name).toBe("p1");
    expect(facade.snapshot()).toEqual(facade.exportSnapshot());
    const joined = game.addPartyMember("p3", "investigator");
    if ("rejected" in joined) throw new Error(`could not create p3: ${joined.rejected}`);
    expect(facade.count).toBe(3);
    expect(facade.get("p3")?.characterId).toBe("p3");
    expect(facade.semanticRevision).toBeGreaterThan(semanticBefore);
    expect(facade.stateReplacementRevision).toBe(replacementBefore);
  });

  it("protects activePlayerId from own-property replacement and keeps ordinary snapshots coherent", async () => {
    const game = makeTwoPlayerSession();
    const before = captureUnchangedActionState(game);
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(game), "activePlayerId");
    try {
      const own = Object.getOwnPropertyDescriptor(game, "activePlayerId");
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();
      expect(Reflect.defineProperty(game, "activePlayerId", { value: "p2", configurable: true })).toBe(false);
      expect(own).toMatchObject({ enumerable: false, configurable: false });
      expect(typeof own?.get).toBe("function");
      expect(own?.set).toBeUndefined();
      expect(() => Object.defineProperty(game, "activePlayerId", { value: "p2" })).toThrow(TypeError);
      expect(() => { (game as any).activePlayerId = "p2"; }).toThrow(TypeError);
      expect(Reflect.set(game, "activePlayerId", "p2")).toBe(false);
      expectUnchangedActionState(game, before);
      const initial = game.exportOrdinarySessionSnapshot();
      expect(initial.state).toMatchObject({ activePlayerId: "p1", activeCharacterId: "p1" });
      expect(game.session.getActive()?.name).toBe("p1");

      const action = await game.act("/roll 1d6", "p2");
      expect(action.error).toBeUndefined();
      expect(game.activePlayerId).toBe("p2");
      expect(game.session.getActive()?.name).toBe("p2");
      expect(game.exportOrdinarySessionSnapshot().state).toMatchObject({ activePlayerId: "p2", activeCharacterId: "p2" });
    } finally {
      // Old implementations allow a configurable same-name shadow before
      // this test reaches its assertions; never leave it on a shared fixture.
      if (Object.getOwnPropertyDescriptor(game, "activePlayerId")?.configurable) {
        delete (game as Record<string, unknown>).activePlayerId;
      }
      game.close();
    }
  });

  it("keeps the ordinary snapshot cohort canonical after a same-name shadow attempt", () => {
    const game = makeTwoPlayerSession();
    const accepted = Reflect.defineProperty(game, "activePlayerId", { value: "p2", configurable: true });
    try {
      const snapshot = game.exportOrdinarySessionSnapshot();
      expect(snapshot.state).toMatchObject({ activePlayerId: "p1", activeCharacterId: "p1" });
      expect(game.session.getActive()?.name).toBe("p1");
      expect(game.activePlayerId).toBe("p1");
    } finally {
      if (accepted) delete (game as Record<string, unknown>).activePlayerId;
      game.close();
    }
  });

  it("exposes activeCharacter as a getter-only detached view and rejects a replacement before summary or snapshot authority can split", () => {
    const game = makeTwoPlayerSession();
    const replacement = structuredClone(game.activeCharacter);
    replacement.name = "owned replacement";
    replacement.attributes.power = 17;
    replacement.skillValues.library_use = 42;
    const beforeSummary = game.getSummary();
    const beforeState = game.getState();
    const beforeSnapshot = game.exportOrdinarySessionSnapshot();
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(game), "activeCharacter");
    let assignmentError: unknown;
    try {
      game.activeCharacter = replacement;
    } catch (error) {
      assignmentError = error;
    }

    const view = game.activeCharacter;
    expect(view).not.toBe(replacement);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.attributes)).toBe(true);
    expect(Object.isFrozen(view.skillValues)).toBe(true);
    expect(() => { view.name = "blocked"; }).toThrow(TypeError);
    expect(() => { view.attributes.power = 1; }).toThrow(TypeError);
    expect(() => { view.skillValues.library_use = 1; }).toThrow(TypeError);

    // Old setter behavior made the summary/state read the replacement while
    // ordinary snapshots kept the old characters-map sheet. This branch
    // records that concrete split before the getter-only contract is applied.
    if (assignmentError === undefined) {
      const afterSnapshot = game.exportOrdinarySessionSnapshot();
      const persisted = afterSnapshot.state.characters.find((entry: { pcId: string; sheet: { name: string } }) => entry.pcId === "p1")!.sheet;
      expect(persisted.name).toBe(game.getSummary().playerName);
    }

    expect(typeof descriptor?.get).toBe("function");
    expect(descriptor?.set).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(game, "activeCharacter")).toBe(false);
    expect(assignmentError).toBeInstanceOf(TypeError);
    expect(game.getSummary()).toEqual(beforeSummary);
    expect(game.getState()).toEqual(beforeState);
    expect(game.exportOrdinarySessionSnapshot()).toEqual(beforeSnapshot);

    const restored: any = new GameSession(game.id, "cosmic-horror", CONFIG);
    restored.restoreOrdinarySessionSnapshot(beforeSnapshot);
    expect(restored.activeCharacter).toEqual(beforeSnapshot.state.characters.find((entry: { pcId: string; sheet: unknown }) => entry.pcId === "p1")!.sheet);
    restored.close();
  });

  it("does not expose public SAN-engine replacement authority that can split snapshots", () => {
    const game = makeTwoPlayerSession();
    const beforeState = game.getState();
    const beforeSnapshot = game.exportOrdinarySessionSnapshot();
    const originalState = structuredClone(game.sanity.state);
    const replacement = new SanityEngine(originalState.maxSAN);
    replacement.restoreState({
      ...originalState,
      currentSAN: originalState.currentSAN > 0 ? originalState.currentSAN - 1 : originalState.maxSAN,
    });
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(game), "sanity");
    const ownDescriptor = Object.getOwnPropertyDescriptor(game, "sanity");
    let assignmentError: unknown;
    try {
      game.sanity = replacement;
    } catch (error) {
      assignmentError = error;
    }

    // The former setter installed only the active reference: getSanity() saw
    // replacement while ordinary persistence retained the canonical p1 map.
    if (assignmentError === undefined) {
      const split = game.exportOrdinarySessionSnapshot();
      const persisted = split.state.sanities.find((entry: { pcId: string; state: { currentSAN: number } }) => entry.pcId === "p1")!.state;
      expect(persisted.currentSAN).toBe(game.getSanity().currentSAN);
      const restored: any = new GameSession(game.id, "cosmic-horror", CONFIG);
      restored.restoreOrdinarySessionSnapshot(split);
      expect(restored.getSanity().currentSAN).toBe(game.getSanity().currentSAN);
      restored.close();
    }

    expect(typeof descriptor?.get).toBe("function");
    expect(descriptor?.set).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(game, "sanity")).toBe(true);
    expect(typeof ownDescriptor?.get).toBe("function");
    expect(ownDescriptor?.set).toBeUndefined();
    expect(ownDescriptor?.configurable).toBe(false);
    expect(assignmentError).toBeInstanceOf(TypeError);
    expect(game.sanity.state).toEqual(originalState);
    expect(game.getState()).toEqual(beforeState);
    expect(game.exportOrdinarySessionSnapshot()).toEqual(beforeSnapshot);
  });

  it("does not expose a live SAN engine whose writes can bypass world persistence", async () => {
    const game = makeTwoPlayerSession();
    const facade: any = game.sanity;
    const beforeWorld = structuredClone(game.world.getPlayerSanity("p1"));

    if (typeof facade.applyLoss === "function") {
      facade.applyLoss(1, () => 0.99);
      expect(game.world.getPlayerSanity("p1").currentSAN).not.toBe(facade.state.currentSAN);
      await game.act("钟态", "p1");
      expect(game.world.getPlayerSanity("p1").currentSAN).toBe(facade.state.currentSAN);
    }

    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade)).toEqual(["state"]);
    expect(Object.isFrozen(facade.state)).toBe(true);
    expect(Object.isFrozen(facade.state.phobias)).toBe(true);
    expect(() => { facade.state.currentSAN = 0; }).toThrow(TypeError);
    expect(() => { facade.state.phobias.push("blocked facade alias"); }).toThrow(TypeError);
    expect(facade.applyLoss).toBeUndefined();
    expect(facade.restoreState).toBeUndefined();
    expect(facade.sanityCheck).toBeUndefined();
    expect(game.world.getPlayerSanity("p1")).toEqual(beforeWorld);
  });

  it("returns an added party member as a frozen state-only SAN projection, never its raw authority", () => {
    const game = makeTwoPlayerSession();
    const added = game.addPartyMember("p3", "investigator");
    if ("rejected" in added) throw new Error(`could not create p3: ${added.rejected}`);

    const publicMember: any = added.member;
    const before = game.exportOrdinarySessionSnapshot();
    const publicPartyMember = game.getState().party.find((member: { pcId: string }) => member.pcId === publicMember.pcId);

    expect(publicMember).not.toBe(publicPartyMember);
    expect(publicMember.san).not.toBe(game.sanity);
    expect(Object.isFrozen(publicMember)).toBe(true);
    expect(Object.isFrozen(publicMember.san)).toBe(true);
    expect(Object.keys(publicMember.san)).toEqual(["state"]);
    expect(publicMember.san.state).toEqual(before.state.sanities.find((entry: { pcId: string }) => entry.pcId === publicMember.pcId)?.state);
    expect(Object.isFrozen(publicMember.san.state)).toBe(true);
    expect(Object.isFrozen(publicMember.san.state.phobias)).toBe(true);
    expect(Object.isFrozen(publicMember.san.state.mythosLog)).toBe(true);
    expect(() => { publicMember.san.state.phobias.push("blocked"); }).toThrow(TypeError);
    for (const authority of ["applyLoss", "restoreState", "sanityCheck", "semanticRevision"]) {
      expect(publicMember.san[authority]).toBeUndefined();
    }
  });

  it("keeps setPlayerSan, public party SAN, world SAN, and ordinary snapshots aligned", () => {
    const game = makeTwoPlayerSession();
    const next = game.sanity.state.currentSAN > 0 ? game.sanity.state.currentSAN - 1 : 1;

    expect(game.setPlayerSan("p1", next).ok).toBe(true);
    expect(game.sanity.state.currentSAN).toBe(next);
    const partyMember = game.getState().party.find((member: { pcId: string }) => member.pcId === "p1");
    expect(partyMember?.san).toBe(next);
    expect(partyMember?.maxSan).toBe(game.sanity.state.maxSAN);
    expect(game.world.getPlayerSanity("p1")).toEqual(game.sanity.state);

    const snapshot = game.exportOrdinarySessionSnapshot();
    expect(snapshot.state.sanities.find((entry: { pcId: string }) => entry.pcId === "p1")?.state).toEqual(game.sanity.state);
    const restored: any = new GameSession(game.id, "cosmic-horror", CONFIG);
    restored.restoreOrdinarySessionSnapshot(snapshot);
    expect(restored.sanity.state).toEqual(game.sanity.state);
    expect(restored.getState().party.find((member: { pcId: string }) => member.pcId === "p1")?.san).toBe(next);
    expect(restored.world.getPlayerSanity("p1")).toEqual(game.sanity.state);
    restored.close();
  });

  it("keeps every active view unchanged when a required intent provider fails for p2", async () => {
    let providerCalls = 0;
    const game = makeTwoPlayerSession("required", {
      chat: async () => {
        providerCalls++;
        throw new Error("test provider is unavailable");
      },
    });
    const before = captureUnchangedActionState(game);

    const response = await game.act("look around", "p2");

    expectUnchangedActionState(game, before);
    expect(response.error).toEqual({
      code: "intent_model_unavailable",
      intentErrorCode: "intent_request_failed",
    });
    expect(providerCalls).toBe(1);
  });

  it("rejects a public SAN replacement during a required provider await without changing the pending p2 switch", async () => {
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerStartedGate = new Promise<void>((resolve) => { providerStarted = resolve; });
    const game = makeTwoPlayerSession("required", {
      chat: async () => {
        providerStarted();
        await providerGate;
        return JSON.stringify({ action: "help" });
      },
    });

    const action = game.act("look around", "p2");
    await providerStartedGate;
    expect(game.activePlayerId).toBe("p1");
    expect(game.session.getActive()?.name).toBe("p1");
    const replacement = new SanityEngine(game.sanity.state.maxSAN);
    replacement.restoreState(game.sanity.state);
    expect(() => { game.sanity = replacement; }).toThrow(TypeError);
    expect(game.session.getActive()?.name).toBe("p1");
    releaseProvider();

    const response = await action;

    expect(response.error).toBeUndefined();
    expect(game.activePlayerId).toBe("p2");
    expect(game.session.getActive()?.name).toBe("p2");
  });

  it("synchronously applies all four active views for a supported p2 switch and keeps a same-actor action a no-op", async () => {
    const game = makeTwoPlayerSession();
    const p2Character = game.exportOrdinarySessionSnapshot().state.characters.find((entry: { pcId: string }) => entry.pcId === "p2")?.sheet;
    const p2Sanity = game.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === "p2")?.state;
    const sanityFacade = game.sanity;

    const first = await game.act("状态", "p2");
    expect(first.error).toBeUndefined();
    expect(game.activePlayerId).toBe("p2");
    expect(game.activeCharacter).toEqual(p2Character);
    expect(game.activeCharacter).not.toBe(p2Character);
    expect(game.sanity).toBe(sanityFacade);
    expect(game.sanity.state).toEqual(p2Sanity);
    expect(game.sanity.state).toEqual(p2Sanity);
    expect(game.session.getActive()?.name).toBe("p2");
    expect(game.getState().party.find((member: { pcId: string }) => member.pcId === "p2")?.san).toBe(p2Sanity?.currentSAN);
    expect(game.world.getPlayerSanity("p2")).toEqual(game.sanity.state);
    expect(game.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === "p2")?.state).toEqual(game.sanity.state);

    const activeCharacter = game.activeCharacter;
    const sanity = game.sanity;
    const second = await game.act("状态", "p2");
    expect(second.error).toBeUndefined();
    expect(game.activePlayerId).toBe("p2");
    expect(game.activeCharacter).toEqual(activeCharacter);
    expect(game.activeCharacter).not.toBe(activeCharacter);
    expect(game.sanity).toBe(sanity);
    expect(game.sanity.state).toEqual(p2Sanity);
    expect(game.session.getActive()?.name).toBe("p2");
  });

  it("allows the initial p1 placeholder to act without attempting a switch", async () => {
    const game: any = new GameSession(`active-placeholder-${crypto.randomUUID()}`, "cosmic-horror", CONFIG);
    expect(game.exportOrdinarySessionSnapshot().state.characters.some((entry: { pcId: string }) => entry.pcId === "p1")).toBe(false);
    const response = await game.act("状态");
    expect(response.error?.code).not.toBe("active_player_state_inconsistent");
    expect(game.activePlayerId).toBe("p1");
    expect(game.activeCharacter).toBeNull();
    expect(game.sanity.state).toEqual(game.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === "p1")?.state);
    expect(game.session.getActive()?.name).toBe("p1");
  });

  it("does not let a rejected public replacement turn the initial p1 placeholder into character authority", async () => {
    const game: any = new GameSession(`active-character-compat-${crypto.randomUUID()}`, "cosmic-horror", CONFIG);
    const replacement = { name: "public p1 replacement", luck: 10, attributes: {} };
    expect(() => { game.activeCharacter = replacement; }).toThrow(TypeError);

    const response = await game.act("状态");

    expect(response.error?.code).not.toBe("active_player_state_inconsistent");
    expect(game.activeCharacter).toBeNull();
    expect(game.activePlayerId).toBe("p1");
    expect(game.sanity.state).toEqual(game.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === "p1")?.state);
    expect(game.session.getActive()?.name).toBe("p1");
  });

  it("keeps a deferred p2 request coherent when an own no-op commit shadow arrives after intent preparation", async () => {
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerStartedGate = new Promise<void>((resolve) => { providerStarted = resolve; });
    const game = makeTwoPlayerSession("required", {
      chat: async () => {
        providerStarted();
        await providerGate;
        return JSON.stringify({ action: "help" });
      },
    });
    try {
      const action = game.act("look around", "p2");
      await providerStartedGate;
      game.commitOrdinaryDirectActor = () => undefined;
      releaseProvider();

      const response = await action;

      expect(game.round).toBe(1);
      expectCanonicalP2Actor(game, response);
    } finally {
      game.close();
    }
  });

  it("does not let a fake direct-actor validator manufacture an action rejection", async () => {
    const game = makeTwoPlayerSession("required", resolvedHelpIntentClient());
    try {
      game.validateOrdinaryDirectActor = () => ({
        narrative: "forged",
        events: [],
        state: game.getState(),
        error: { code: "forged_actor_validation" },
      });

      const response = await game.act("look around", "p2");

      expect(game.round).toBe(1);
      expectCanonicalP2Actor(game, response);
    } finally {
      game.close();
    }
  });

  it("does not let a throwing direct-actor validator fail-stop a normal p2 action", async () => {
    const game = makeTwoPlayerSession("required", resolvedHelpIntentClient());
    try {
      game.validateOrdinaryDirectActor = () => { throw new Error("forged validator failure"); };

      const response = await game.act("look around", "p2");
      expectCanonicalP2Actor(game, response);

      const followUp = await game.act("look around", "p1");
      expect(followUp.error).toBeUndefined();
      expect(game.activePlayerId).toBe("p1");
    } finally {
      game.close();
    }
  });

  it("does not let a no-op active-character installer split a real p2 action from its selected sheet", async () => {
    const game = makeTwoPlayerSession("required", resolvedHelpIntentClient());
    try {
      game.installActiveCharacter = () => undefined;

      const response = await game.act("look around", "p2");

      expectCanonicalP2Actor(game, response);
    } finally {
      game.close();
    }
  });

  it("does not let a throwing active-character installer leave a half switch or fail-stop the session", async () => {
    const game = makeTwoPlayerSession("required", resolvedHelpIntentClient());
    try {
      game.installActiveCharacter = () => { throw new Error("forged character installer failure"); };

      const response = await game.act("look around", "p2");
      expectCanonicalP2Actor(game, response);

      const followUp = await game.act("look around", "p1");
      expect(followUp.error).toBeUndefined();
      expect(game.activePlayerId).toBe("p1");
    } finally {
      game.close();
    }
  });

  it("does not let a no-op SAN installer split p2 from its public SAN cohort", async () => {
    const game = makeTwoPlayerSession("required", resolvedHelpIntentClient());
    try {
      expect(game.setPlayerSan("p1", 1)).toMatchObject({ ok: true });
      expect(game.setPlayerSan("p2", 2)).toMatchObject({ ok: true });
      game.installSanityEngine = () => undefined;

      const response = await game.act("look around", "p2");

      expectCanonicalP2Actor(game, response);
      expect(game.sanity.state.currentSAN).toBe(2);
    } finally {
      game.close();
    }
  });

  it("does not let a throwing SAN installer leave a half switch or fail-stop the session", async () => {
    const game = makeTwoPlayerSession("required", resolvedHelpIntentClient());
    try {
      expect(game.setPlayerSan("p1", 1)).toMatchObject({ ok: true });
      expect(game.setPlayerSan("p2", 2)).toMatchObject({ ok: true });
      game.installSanityEngine = () => { throw new Error("forged SAN installer failure"); };

      const response = await game.act("look around", "p2");
      expectCanonicalP2Actor(game, response);
      expect(game.sanity.state.currentSAN).toBe(2);

      const followUp = await game.act("look around", "p1");
      expect(followUp.error).toBeUndefined();
      expect(game.activePlayerId).toBe("p1");
    } finally {
      game.close();
    }
  });

  for (const mode of ["fake", "throwing"] as const) {
    it(`does not let ${mode} active-player-inconsistency shadows control an action after an installer-shadow attempt`, async () => {
      const game = makeTwoPlayerSession("required", resolvedHelpIntentClient());
      try {
        // On the legacy implementation this first shadow leaves p2 selected
        // while #sanityRaw still names p1, making the next direct-act
        // validation take activePlayerStateInconsistent().
        game.installSanityEngine = () => undefined;
        const first = await game.act("look around", "p2");
        expect(first.error).toBeUndefined();
        game.activePlayerStateInconsistent = mode === "fake"
          ? () => ({ narrative: "forged", events: [], state: game.getState(), error: { code: "forged_inconsistency" } })
          : () => { throw new Error("forged inconsistency failure"); };

        const response = await game.act("look around", "p2");

        expectCanonicalP2Actor(game, response);
        expect(game.round).toBe(2);
      } finally {
        game.close();
      }
    });
  }
});
