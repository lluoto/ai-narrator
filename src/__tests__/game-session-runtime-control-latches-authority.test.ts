import { expect, it } from "bun:test";
import { GameSession } from "../api/game-session";

const TEST_LLM = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
};

const LOAD_BARN = "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3";
const LEAVE = "\u6211\u4eec\u51b3\u5b9a\u79bb\u5f00\u8fd9\u91cc\uff0c\u7ed3\u675f\u8fd9\u6b21\u8c03\u67e5";
const CONFIRM = "\u786e\u5b9a";
const OBSERVE = "\u89c2\u5bdf";
const COMPOUND_MOVE = "\u68c0\u67e5\u52a0\u6bd4\u7684\u62d6\u8f66\u623f\u91cc\u7684\u5e8a\u5e95\u548c\u67dc\u5b50\uff0c\u770b\u6709\u6ca1\u6709\u85cf\u4e1c\u897f\u3002";
const TRAILER = "\u52a0\u6bd4\u7684\u62d6\u8f66\u623f";

function legacyFresh(id: string): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(id, "cosmic-horror", TEST_LLM, undefined, "\u8c03\u67e5\u5458", undefined, undefined, undefined, "preferred", { careerEntryPersistence: "transient" });
}

function fresh(id: string): GameSession {
  return legacyFresh(id);
  /*
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(id, "cosmic-horror", TEST_LLM, undefined, "调查员", undefined, undefined, undefined, "preferred", { careerEntryPersistence: "transient" });
}

  */
}

async function withBarn(id: string): Promise<GameSession> {
  const session = fresh(id);
  await session.act(LOAD_BARN);
  return session;
}

async function legacyWithTerminalBarn(id: string): Promise<GameSession> {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const session = new GameSession(id, "cosmic-horror", TEST_LLM, "detective", "\u8c03\u67e5\u5458", undefined, undefined, undefined, "preferred", { careerEntryPersistence: "transient" });
  await session.act(LOAD_BARN);
  return session;
}

async function withTerminalBarn(id: string): Promise<GameSession> {
  return legacyWithTerminalBarn(id);
  /*
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const session = new GameSession(id, "cosmic-horror", TEST_LLM, "detective", "调查员", undefined, undefined, undefined, "preferred", { careerEntryPersistence: "transient" });
  await session.act(LOAD_BARN);
  return session;
}

  */
}

async function requestCompoundMove(session: GameSession): Promise<void> {
  const response = await session.act(COMPOUND_MOVE);
  expect(response.events.some((event) => event.speaker === "\u7cfb\u7edf" && event.content.includes("\u4f60\u662f\u8981\u5148\u53bb"))).toBe(true);
}

async function departedBarn(id: string): Promise<{ session: GameSession; terminal: NonNullable<ReturnType<GameSession["getOrdinaryTerminal"]>> }> {
  const session = await withTerminalBarn(id);
  await session.act(LEAVE);
  const departed = await session.act(CONFIRM);
  if (!departed.terminal || departed.terminal.kind !== "module_departure") {
    session.close();
    throw new Error("Barn fixture must establish a real departure terminal");
  }
  return { session, terminal: departed.terminal };
}

function terminalAuthorityView(session: GameSession) {
  const state = session.getState();
  return structuredClone({
    terminal: session.getOrdinaryTerminal(),
    round: state.round,
    gameTime: state.gameTime,
    history: session.getPlayerHistory("p1"),
    snapshot: session.exportOrdinarySessionSnapshot(),
  });
}

it("does not let public ordinaryTerminal shadows fabricate a live-session terminal", async () => {
  const assigned = fresh("runtime-control-terminal-assignment");
  const defined = fresh("runtime-control-terminal-definition");
  try {
    (assigned as unknown as Record<string, unknown>).ordinaryTerminal = { kind: "death" };
    Object.defineProperty(defined, "ordinaryTerminal", {
      value: { kind: "death" }, configurable: true, writable: true,
    });

    for (const session of [assigned, defined]) {
      const response = await session.act(OBSERVE);
      expect(response).toMatchObject({ dead: false });
      expect(session.getOrdinaryTerminal()).toBeNull();
    }
  } finally {
    assigned.close();
    defined.close();
  }
});

it("does not let a public ordinaryTerminal shadow reopen an actual departure terminal", async () => {
  const session = await withBarn("runtime-control-terminal-clear");
  try {
    await session.act(LEAVE);
    const departed = await session.act(CONFIRM);
    expect(departed).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    const terminal = session.getOrdinaryTerminal();

    Object.defineProperty(session, "ordinaryTerminal", { value: null, configurable: true, writable: true });
    const blocked = await session.act(OBSERVE);

    expect(session.getOrdinaryTerminal()).toEqual(terminal);
    expect(blocked).toMatchObject({ dead: false, terminal });
    expect(blocked.events).toHaveLength(1);
    expect(blocked.events[0]?.type).toBe("system");
  } finally {
    session.close();
  }
});

it("does not let a public pendingLeaveConfirm=true shadow confirm departure before a leave request", async () => {
  const session = await withBarn("runtime-control-leave-fabricate");
  try {
    Object.defineProperty(session, "pendingLeaveConfirm", { value: true, configurable: true, writable: true });
    const response = await session.act(CONFIRM);

    expect(response).toMatchObject({ dead: false });
    expect(session.getOrdinaryTerminal()).toBeNull();
  } finally {
    session.close();
  }
});

it("does not let a public pendingLeaveConfirm=false shadow cancel a legitimate pending departure", async () => {
  const session = await withBarn("runtime-control-leave-clear");
  try {
    const requested = await session.act(LEAVE);
    expect(requested.events.some((event) => event.speaker === "\u7cfb\u7edf" && event.content.includes("\u786e\u5b9a\u8981\u79bb\u5f00"))).toBe(true);

    Object.defineProperty(session, "pendingLeaveConfirm", { value: false, configurable: true, writable: true });
    const departed = await session.act(CONFIRM);

    expect(departed).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    expect(session.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
  } finally {
    session.close();
  }
});

it("does not let an attacker-provided pendingCompoundMove Map hijack the next action", async () => {
  const attacked = await withBarn("runtime-control-compound-attacked");
  const control = await withBarn("runtime-control-compound-control");
  try {
    // This uses the same fixture input and intent route as a production
    // compound re-ask. The Map itself is the hostile runtime shadow under
    // test; there is no production queue injection API.
    Object.defineProperty(attacked, "pendingCompoundMove", {
      value: new Map([["p1", { originalInput: COMPOUND_MOVE, originalIntent: { action: "skill_check" } }]]),
      configurable: true,
      writable: true,
    });
    const attackedResponse = await attacked.act(TRAILER);
    const controlResponse = await control.act(TRAILER);

    expect(attackedResponse.state).toEqual(controlResponse.state);
  } finally {
    attacked.close();
    control.close();
  }
});

it("does not let clearing the public pendingCompoundMove name cancel a real per-PC reply", async () => {
  const intact = await withBarn("runtime-control-compound-intact");
  const shadowed = await withBarn("runtime-control-compound-shadowed");
  const originalRandom = Math.random;
  try {
    // The production compound fixture can resolve a check; lock its ordinary
    // dice branch so the two real flows are directly comparable.
    Math.random = () => 0;
    await requestCompoundMove(intact);
    await requestCompoundMove(shadowed);
    Object.defineProperty(shadowed, "pendingCompoundMove", {
      value: new Map(), configurable: true, writable: true,
    });

    const intactResponse = await intact.act(TRAILER);
    const shadowedResponse = await shadowed.act(TRAILER);

    expect(shadowedResponse).toEqual(intactResponse);
    expect(shadowed.getDisplayedScene()).toBe(TRAILER);
  } finally {
    Math.random = originalRandom;
    intact.close();
    shadowed.close();
  }
});

it("keeps a real departure terminal closed when every ordinary-terminal helper is shadowed", async () => {
  const { session, terminal } = await departedBarn("runtime-control-terminal-helper-false");
  try {
    const before = terminalAuthorityView(session);
    Object.defineProperties(session, {
      ordinaryTerminalState: { configurable: true, value: () => null },
      ordinarySessionIsTerminal: { configurable: true, value: () => false },
      ordinaryTerminalActionMessage: { configurable: true, value: () => "forged terminal message" },
      setOrdinaryTerminal: { configurable: true, value: () => {} },
    });

    const blocked = await session.act(OBSERVE);

    expect(blocked).toMatchObject({ dead: false, terminal });
    expect(blocked.events).toHaveLength(1);
    expect(blocked.events[0]).toMatchObject({ type: "system" });
    const after = terminalAuthorityView(session);
    expect(after.terminal).toEqual(before.terminal);
    expect(after.round).toBe(before.round);
    expect(after.gameTime).toEqual(before.gameTime);
    expect(after.history.total).toBe(before.history.total + 1);
    expect(after.history.messages.at(-1)).toMatchObject(blocked.events[0] ?? {});
    expect(after.snapshot.state).toMatchObject({ terminal: before.snapshot.state.terminal, round: before.snapshot.state.round, gameTime: before.snapshot.state.gameTime });
  } finally {
    session.close();
  }
});

it("does not let throwing ordinary-terminal helper shadows DoS observation, snapshot export, or a blocked action", async () => {
  const { session, terminal } = await departedBarn("runtime-control-terminal-helper-throwing");
  try {
    const before = terminalAuthorityView(session);
    const forged = () => { throw new Error("forged ordinary terminal helper"); };
    Object.defineProperties(session, {
      ordinaryTerminalState: { configurable: true, value: forged },
      ordinarySessionIsTerminal: { configurable: true, value: forged },
      ordinaryTerminalActionMessage: { configurable: true, value: forged },
      setOrdinaryTerminal: { configurable: true, value: forged },
    });

    expect(() => session.getOrdinaryTerminal()).not.toThrow();
    expect(() => session.exportOrdinarySessionSnapshot()).not.toThrow();
    const blocked = await session.act(OBSERVE);

    expect(blocked).toMatchObject({ dead: false, terminal });
    const after = terminalAuthorityView(session);
    expect(after.terminal).toEqual(before.terminal);
    expect(after.round).toBe(before.round);
    expect(after.gameTime).toEqual(before.gameTime);
    expect(after.history.total).toBe(before.history.total + 1);
    expect(after.history.messages.at(-1)).toMatchObject(blocked.events[0] ?? {});
    expect(after.snapshot.state).toMatchObject({ terminal: before.snapshot.state.terminal, round: before.snapshot.state.round, gameTime: before.snapshot.state.gameTime });
  } finally {
    session.close();
  }
});

it("records a real departure when setOrdinaryTerminal is shadowed with a no-op before confirmation", async () => {
  const session = await withTerminalBarn("runtime-control-terminal-set-noop");
  try {
    await session.act(LEAVE);
    Object.defineProperty(session, "setOrdinaryTerminal", { configurable: true, value: () => {} });

    const departed = await session.act(CONFIRM);
    const terminal = session.getOrdinaryTerminal();
    const afterDeparture = terminalAuthorityView(session);
    const blocked = await session.act(OBSERVE);

    expect(departed).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    expect(terminal).toMatchObject({ kind: "module_departure" });
    expect(afterDeparture.snapshot.state.terminal).toEqual(terminal);
    expect(blocked).toMatchObject({ dead: false, terminal });
    const afterBlocked = terminalAuthorityView(session);
    expect(afterBlocked.terminal).toEqual(afterDeparture.terminal);
    expect(afterBlocked.round).toBe(afterDeparture.round);
    expect(afterBlocked.gameTime).toEqual(afterDeparture.gameTime);
    expect(afterBlocked.history.total).toBe(afterDeparture.history.total + 1);
    expect(afterBlocked.history.messages.at(-1)).toMatchObject(blocked.events[0] ?? {});
    expect(afterBlocked.snapshot.state).toMatchObject({ terminal: afterDeparture.snapshot.state.terminal, round: afterDeparture.snapshot.state.round, gameTime: afterDeparture.snapshot.state.gameTime });
  } finally {
    session.close();
  }
});

it("records a real departure when setOrdinaryTerminal is shadowed with a throwing function before confirmation", async () => {
  const session = await withTerminalBarn("runtime-control-terminal-set-throwing");
  try {
    await session.act(LEAVE);
    Object.defineProperty(session, "setOrdinaryTerminal", {
      configurable: true,
      value: () => { throw new Error("forged ordinary terminal setter"); },
    });

    const departed = await session.act(CONFIRM);
    const terminal = session.getOrdinaryTerminal();
    const afterDeparture = terminalAuthorityView(session);
    const blocked = await session.act(OBSERVE);

    expect(departed).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    expect(terminal).toMatchObject({ kind: "module_departure" });
    expect(afterDeparture.snapshot.state.terminal).toEqual(terminal);
    expect(blocked).toMatchObject({ dead: false, terminal });
    const afterBlocked = terminalAuthorityView(session);
    expect(afterBlocked.terminal).toEqual(afterDeparture.terminal);
    expect(afterBlocked.round).toBe(afterDeparture.round);
    expect(afterBlocked.gameTime).toEqual(afterDeparture.gameTime);
    expect(afterBlocked.history.total).toBe(afterDeparture.history.total + 1);
    expect(afterBlocked.history.messages.at(-1)).toMatchObject(blocked.events[0] ?? {});
    expect(afterBlocked.snapshot.state).toMatchObject({ terminal: afterDeparture.snapshot.state.terminal, round: afterDeparture.snapshot.state.round, gameTime: afterDeparture.snapshot.state.gameTime });
  } finally {
    session.close();
  }
});
