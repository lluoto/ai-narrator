import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";

const CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid/v1",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

const RUNTIME = {
  careerEntryPersistence: "transient" as const,
  characterRandomUnit: () => 0.25,
};

type ShadowMode = "fake" | "throw";
type CreatePartyMemberShadow = (...args: unknown[]) => unknown;

function fresh(id: string, archetypeId?: string, characterName?: string): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    CONFIG,
    archetypeId,
    characterName,
    undefined,
    undefined,
    undefined,
    "preferred",
    RUNTIME,
  );
}

function forgedResult() {
  return {
    member: {
      pcId: "p99",
      sheet: { name: "ForgedMember", archetypeId: "forged_archetype" },
      san: {},
      control: "auto",
    },
  };
}

function installCreatePartyMemberShadow(
  target: object,
  mode: ShadowMode,
  forged: ReturnType<typeof forgedResult>,
): () => void {
  const original = Object.getOwnPropertyDescriptor(target, "createPartyMember");
  const decoy: CreatePartyMemberShadow = () => {
    if (mode === "throw") throw new Error("FORGED_CREATE_PARTY_MEMBER");
    return forged;
  };
  Object.defineProperty(target, "createPartyMember", { configurable: true, value: decoy });
  return () => {
    if (original) Object.defineProperty(target, "createPartyMember", original);
    else Reflect.deleteProperty(target, "createPartyMember");
  };
}

function expectNoForgedMember(session: GameSession): void {
  const snapshot = session.exportOrdinarySessionSnapshot();
  expect(snapshot.state.characters.some((entry) => {
    const sheet = entry.sheet as { name?: unknown } | null;
    return entry.pcId === "p99" || sheet?.name === "ForgedMember";
  })).toBe(false);
  expect(snapshot.state.party.some((entry) => entry.pcId === "p99")).toBe(false);
}

function expectCanonicalMember(
  session: GameSession,
  pcId: string,
  name: string,
  activePlayerId: string,
): void {
  const snapshot = session.exportOrdinarySessionSnapshot();
  const character = snapshot.state.characters.find((entry) => entry.pcId === pcId);
  const party = snapshot.state.party.find((entry) => entry.pcId === pcId);
  expect(character?.sheet).toMatchObject({ name, archetypeId: "investigator" });
  expect(party).toMatchObject({ pcId });
  expect(session.session.get(pcId)).toBeDefined();
  expect(session.world.getPlayerIds()).toEqual(expect.arrayContaining([pcId]));
  expect(session.world.getPlayerState(pcId)).not.toBeNull();
  expect(session.world.getEntity(pcId)).toMatchObject({ id: pcId, name });
  expect(session.activePlayerId).toBe(activePlayerId);
}

function expectDirectDecoy(
  session: GameSession,
  mode: ShadowMode,
  forged: ReturnType<typeof forgedResult>,
): void {
  const invoke = () => (session as any).createPartyMember("p99", { name: "ForgedMember" });
  if (mode === "throw") expect(invoke).toThrow("FORGED_CREATE_PARTY_MEMBER");
  else expect(invoke()).toBe(forged);
}

describe("GameSession createPartyMember private authority", () => {
  for (const mode of ["fake", "throw"] as const) {
    it(`keeps a prototype ${mode} createPartyMember shadow out of constructor p1 creation`, () => {
      const forged = forgedResult();
      const restore = installCreatePartyMemberShadow(GameSession.prototype, mode, forged);
      let session: GameSession | undefined;
      try {
        session = fresh(`create-party-member-constructor-${mode}`, "investigator", "Ada");
        expectCanonicalMember(session, "p1", "Ada", "p1");
        expectNoForgedMember(session);
      } finally {
        session?.close();
        restore();
      }
    });
  }

  for (const kind of ["own", "prototype"] as const) {
    for (const mode of ["fake", "throw"] as const) {
      it(`keeps a ${kind} ${mode} createPartyMember shadow out of public addPartyMember`, () => {
        const session = fresh(`create-party-member-add-${kind}-${mode}`, "investigator", "Ada");
        const forged = forgedResult();
        const target = kind === "own" ? session : GameSession.prototype;
        const restore = installCreatePartyMemberShadow(target, mode, forged);
        try {
          expectDirectDecoy(session, mode, forged);

          const added = session.addPartyMember("Luna", "investigator");
          if ("rejected" in added) throw new Error(added.rejected);
          expect(added.member).toMatchObject({ pcId: "p2", sheet: { name: "Luna", archetypeId: "investigator" } });
          expectCanonicalMember(session, "p2", "Luna", "p1");
          expectNoForgedMember(session);
        } finally {
          restore();
          session.close();
        }
      });
    }
  }

  for (const kind of ["own", "prototype"] as const) {
    for (const mode of ["fake", "throw"] as const) {
      it(`keeps a ${kind} ${mode} createPartyMember shadow out of text character creation`, async () => {
        const session = fresh(`create-party-member-command-${kind}-${mode}`);
        const forged = forgedResult();
        const target = kind === "own" ? session : GameSession.prototype;
        const restore = installCreatePartyMemberShadow(target, mode, forged);
        try {
          const response = await session.act("创建角色 investigator Ada");
          expect(response.error).toBeUndefined();
          expectCanonicalMember(session, "p1", "Ada", "p1");
          expectNoForgedMember(session);
        } finally {
          restore();
          session.close();
        }
      });
    }
  }
});
