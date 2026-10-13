import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";

const CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid/v1",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

const INSTALLERS = [
  "installIdReadAccessor",
  "installTimestampReadAccessors",
  "installActivePlayerIdReadAccessor",
  "installOrdinaryCharacterEditorReadAccessor",
  "installSkillGrowthMarksReadAccessor",
  "installActiveActionTransactionsReadAccessor",
  "installDurableCompiledSessionReadAccessor",
  "installWorldReadAccessor",
  "installSessionReadAccessor",
] as const;

type Installer = typeof INSTALLERS[number];
type DecoyMode = "fake" | "throw";

type InstalledDecoy = Readonly<{
  marker: object;
  calls: () => number;
  restore: () => void;
}>;

function fresh(label: string): GameSession {
  return new GameSession(
    `constructor-installer-authority-${label}-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
  );
}

function installPrototypeDecoy(installer: Installer, mode: DecoyMode): InstalledDecoy {
  const original = Object.getOwnPropertyDescriptor(GameSession.prototype, installer);
  const marker = Object.freeze({ installer, mode, forged: true });
  let calls = 0;
  Object.defineProperty(GameSession.prototype, installer, {
    configurable: true,
    writable: true,
    value: () => {
      calls++;
      if (mode === "throw") throw new Error(`FORGED_${installer}`);
      return marker;
    },
  });
  return Object.freeze({
    marker,
    calls: () => calls,
    restore: () => {
      if (original) Object.defineProperty(GameSession.prototype, installer, original);
      else Reflect.deleteProperty(GameSession.prototype, installer);
    },
  });
}

function assertDirectDecoyControl(installer: Installer, mode: DecoyMode, decoy: InstalledDecoy): void {
  const invoke = () => (GameSession.prototype as unknown as Record<string, () => unknown>)[installer]();
  if (mode === "throw") expect(invoke).toThrow(`FORGED_${installer}`);
  else expect(invoke()).toBe(decoy.marker);
  expect(decoy.calls()).toBe(1);
}

const publicSlots = [
  { key: "id", forged: "forged-session-id", enumerable: true, kind: "getter" },
  { key: "createdAt", forged: -1, enumerable: true, kind: "getter" },
  { key: "lastActiveAt", forged: -1, enumerable: true, kind: "getter" },
  { key: "activePlayerId", forged: "p99", enumerable: false, kind: "getter" },
  { key: "getOrdinaryCharacterEditorProjection", forged: () => ({ pcId: "p99" }), enumerable: false, kind: "value" },
  { key: "skillGrowthMarks", forged: ["forged-mark"], enumerable: false, kind: "getter" },
  { key: "hasActiveActionTransactions", forged: true, enumerable: false, kind: "getter" },
  { key: "isDurableCompiledSession", forged: () => true, enumerable: false, kind: "value" },
  { key: "world", forged: Object.freeze({ forged: true }), enumerable: false, kind: "getter" },
  { key: "session", forged: Object.freeze({ get: () => ({ id: "p99" }) }), enumerable: true, kind: "getter" },
] as const;

function assertSealedPublicSlots(session: GameSession): void {
  const target = session as unknown as Record<string, unknown>;
  for (const slot of publicSlots) {
    const descriptor = Object.getOwnPropertyDescriptor(session, slot.key);
    expect(Object.hasOwn(session, slot.key)).toBe(true);
    expect(descriptor).toMatchObject({ enumerable: slot.enumerable, configurable: false });
    if (slot.kind === "getter") {
      expect(descriptor?.get).toBeInstanceOf(Function);
      expect(descriptor?.set).toBeUndefined();
    } else {
      expect(descriptor?.value).toBeInstanceOf(Function);
      expect(descriptor?.writable).toBe(false);
    }
    expect(Reflect.set(session, slot.key, slot.forged)).toBe(false);
    expect(Reflect.defineProperty(session, slot.key, { value: slot.forged })).toBe(false);
    expect(target[slot.key]).not.toBe(slot.forged);
  }
}

async function assertCanonicalObservations(session: GameSession): Promise<void> {
  const snapshot = session.exportOrdinarySessionSnapshot();
  const world = session.world;
  const playerSession = session.session;
  const editor = session.getOrdinaryCharacterEditorProjection();

  expect(session.id).toMatch(/^constructor-installer-authority-/);
  expect(session.getSummary().id).toBe(session.id);
  expect(snapshot.session.id).toBe(session.id);
  expect(session.createdAt).toBe(snapshot.session.createdAt);
  expect(session.lastActiveAt).toBe(snapshot.session.lastActiveAt);
  expect(session.activePlayerId).toBe("p1");
  expect(snapshot.state.activePlayerId).toBe("p1");
  expect(editor).toMatchObject({ pcId: "p1", summary: { id: session.id }, character: { name: "Ada" } });
  expect(session.skillGrowthMarks).toEqual([]);
  expect(Object.isFrozen(session.skillGrowthMarks)).toBe(true);
  expect(session.hasActiveActionTransactions).toBe(false);
  expect(session.isDurableCompiledSession()).toBe(false);
  expect(world.getPlayerIds()).toContain("p1");
  expect(world.getEntity("p1")).toMatchObject({ id: "p1", name: "Ada" });
  expect(playerSession.get("p1")).toBeDefined();

  await session.runExclusiveActionTransaction(async () => {
    expect(session.hasActiveActionTransactions).toBe(true);
  });
  expect(session.hasActiveActionTransactions).toBe(false);

  assertSealedPublicSlots(session);
  expect(session.world).toBe(world);
  expect(session.session).toBe(playerSession);
  expect(session.getSummary().id).toBe(session.id);
  expect(session.exportOrdinarySessionSnapshot().session).toEqual(snapshot.session);
  expect(session.activePlayerId).toBe("p1");
  expect(session.getOrdinaryCharacterEditorProjection()).toMatchObject({ pcId: "p1", summary: { id: session.id } });
  expect(session.skillGrowthMarks).toEqual([]);
  expect(session.hasActiveActionTransactions).toBe(false);
  expect(session.isDurableCompiledSession()).toBe(false);
  expect(session.world.getEntity("p1")).toMatchObject({ id: "p1", name: "Ada" });
  expect(session.session.get("p1")).toBeDefined();
}

describe("GameSession constructor installer private authority", () => {
  for (const installer of INSTALLERS) {
    for (const mode of ["fake", "throw"] as const) {
      it(`keeps a prototype ${mode} ${installer} decoy outside canonical constructor installation`, async () => {
        const decoy = installPrototypeDecoy(installer, mode);
        let session: GameSession | undefined;
        try {
          assertDirectDecoyControl(installer, mode, decoy);
          session = fresh(`${installer}-${mode}`);
          expect(decoy.calls()).toBe(1);
          await assertCanonicalObservations(session);
        } finally {
          session?.close();
          decoy.restore();
        }
      });
    }
  }
});
