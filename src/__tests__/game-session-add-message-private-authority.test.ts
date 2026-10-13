import { afterEach, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { newStatus } from "../rules/status-effects";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

type ShadowTarget = "own" | "prototype";
type ShadowKind = "no-op" | "throwing";
type PublicAddMessage = GameSession["addMessage"];

const sessions: GameSession[] = [];
const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
  while (sessions.length > 0) sessions.pop()!.close();
});

function fresh(label: string, withCharacter = true): GameSession {
  const session = new GameSession(
    `add-message-private-authority-${label}-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { careerEntryPersistence: "transient" },
  );
  sessions.push(session);
  return session;
}

function shadowPublicAddMessage(session: GameSession, target: ShadowTarget, shadow: PublicAddMessage): void {
  const receiver = target === "own" ? session : GameSession.prototype;
  const original = Object.getOwnPropertyDescriptor(receiver, "addMessage");
  Object.defineProperty(receiver, "addMessage", { configurable: true, writable: true, value: shadow });
  restorers.push(() => {
    if (original) Object.defineProperty(receiver, "addMessage", original);
    else Reflect.deleteProperty(receiver, "addMessage");
  });
}

function publicAddMessageShadow(kind: ShadowKind): PublicAddMessage {
  return kind === "no-op"
    ? () => undefined
    : () => { throw new Error("forged public addMessage"); };
}

function assertPublicShadowRemainsObservable(session: GameSession, kind: ShadowKind, content: string): void {
  if (kind === "no-op") {
    session.addMessage("KP", content, "narration");
    expect(session.getHistory().messages.some((message) => message.content === content)).toBe(false);
    return;
  }
  expect(() => session.addMessage("KP", content, "narration")).toThrow("forged public addMessage");
}

function snapshotHistory(session: GameSession): Array<{ content: string }> {
  const snapshot = session.exportOrdinarySessionSnapshot();
  const active = snapshot.playerSession.players.find((player) => player.name === "p1");
  if (!active) throw new Error("fixture requires p1 history in the signed ordinary snapshot");
  return active.messageHistory;
}

function seedTickingPlayer(session: GameSession): void {
  restoreSignedOrdinaryWorld(session, CONFIG, (world) => {
    const player = world.getEntity("p1");
    if (!player) throw new Error("fixture requires the ordinary p1 world entity");
    world.upsertEntity({
      ...player,
      status: [newStatus("bleeding"), newStatus("blinded", 1)],
    });
  });
}

function expectCanonicalTickFacts(session: GameSession): void {
  const player = session.world.getEntity("p1");
  expect(player).not.toBeNull();
  expect(player!.hp).toBe(player!.maxHp - 1);
  expect(player!.status).toContain(newStatus("bleeding", 2));
  expect(player!.status).not.toContain(newStatus("blinded", 1));

  const history = session.getHistory().messages;
  expect(history.some((message) => message.content.includes("失去 1 HP"))).toBe(true);
  expect(history.some((message) => message.content.includes("结束了"))).toBe(true);
  expect(snapshotHistory(session).map((message) => message.content)).toEqual(history.map((message) => message.content));
}

for (const target of ["own", "prototype"] as const) {
  for (const kind of ["no-op", "throwing"] as const) {
    test(`${target} ${kind} addMessage shadow remains public-only while sendMessage writes canonical history`, () => {
      const session = fresh(`${target}-${kind}-send`);
      shadowPublicAddMessage(session, target, publicAddMessageShadow(kind));

      // Negative control: the compatibility public surface remains dynamically shadowable.
      assertPublicShadowRemainsObservable(session, kind, `public ${target} ${kind} addMessage shadow`);

      const content = `canonical send under ${target} ${kind}`;
      expect(() => session.sendMessage("KP", content, "narration")).not.toThrow();
      expect(session.sendMessage("KP", content, "narration")).toBe(true);
      const history = session.getHistory().messages;
      expect(history.map((message) => message.content)).toContain(content);
      expect(snapshotHistory(session).map((message) => message.content)).toEqual(history.map((message) => message.content));
    });

    test(`${target} ${kind} addMessage shadow cannot discard or DoS real bleeding damage and expiry audit`, async () => {
      const session = fresh(`${target}-${kind}-tick`, false);
      seedTickingPlayer(session);
      shadowPublicAddMessage(session, target, publicAddMessageShadow(kind));
      assertPublicShadowRemainsObservable(session, kind, `public ${target} ${kind} tick shadow`);

      const response = await session.act("/help");
      expect(response.error).toBeUndefined();
      expectCanonicalTickFacts(session);
    });
  }
}
