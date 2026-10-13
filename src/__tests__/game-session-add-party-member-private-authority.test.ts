import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

type ShadowKind = "own" | "prototype";
type ShadowMode = "fake_success" | "fake_rejected" | "throw";

function shadowResult(mode: Exclude<ShadowMode, "throw">): unknown {
  if (mode === "fake_rejected") return { rejected: "FORGED_REJECTION" };
  return {
    member: {
      pcId: "p99",
      sheet: { name: "ForgedMember", archetype: "forged_archetype" },
      san: {},
      control: "auto",
    },
  };
}

function installAddPartyMemberShadow(session: GameSession, kind: ShadowKind, mode: ShadowMode): () => void {
  const target = kind === "own" ? session : GameSession.prototype;
  const original = Object.getOwnPropertyDescriptor(target, "addPartyMember");
  const fake = mode === "throw" ? undefined : shadowResult(mode);
  Object.defineProperty(target, "addPartyMember", {
    configurable: true,
    value: () => {
      if (mode === "throw") throw new Error(`FORGED_ADD_PARTY_MEMBER_${kind}`);
      return fake;
    },
  });
  return () => {
    if (original) Object.defineProperty(target, "addPartyMember", original);
    else Reflect.deleteProperty(target, "addPartyMember");
  };
}

function canonicalP2View(session: GameSession) {
  const snapshot = session.exportOrdinarySessionSnapshot();
  const character = snapshot.state.characters.find((entry) => entry.pcId === "p2");
  const party = snapshot.state.party.find((entry) => entry.pcId === "p2");
  return { snapshot, character, party };
}

describe("text recruit private authority", () => {
  for (const kind of ["own", "prototype"] as const) {
    for (const mode of ["fake_success", "fake_rejected", "throw"] as const) {
      it(`keeps a ${kind} ${mode} addPartyMember shadow out of the real text recruit path`, async () => {
        const session = new GameSession(`party-member-private-${kind}-${mode}`, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, undefined, undefined, "preferred", { careerEntryPersistence: "transient" });
        let restore = () => {};
        try {
          restore = installAddPartyMemberShadow(session, kind, mode);

          if (mode === "throw") {
            expect(() => session.addPartyMember("NegativeControl", "investigator"))
              .toThrow(`FORGED_ADD_PARTY_MEMBER_${kind}`);
          } else {
            expect(session.addPartyMember("NegativeControl", "investigator"))
              .toEqual(shadowResult(mode) as ReturnType<GameSession["addPartyMember"]>);
          }

          const response = await session.act("\u521b\u5efa\u961f\u53cb Luna investigator", "p1");
          expect(response.error).toBeUndefined();
          expect(JSON.stringify(response)).not.toContain("ForgedMember");
          expect(JSON.stringify(response)).not.toContain("FORGED_REJECTION");

          const { snapshot, character, party } = canonicalP2View(session);
          expect(character?.sheet).toMatchObject({ name: "Luna", archetypeId: "investigator" });
          expect(party).toMatchObject({ pcId: "p2" });
          expect(session.session.get("p2")).toBeDefined();
          expect(session.world.getPlayerIds()).toEqual(expect.arrayContaining(["p1", "p2"]));
          expect(session.world.getPlayerState("p2")).not.toBeNull();
          expect(session.activePlayerId).toBe("p1");
          expect(snapshot.state.characters.some((entry) => {
            const sheet = entry.sheet as { name?: unknown } | null;
            return entry.pcId === "p99" || sheet?.name === "ForgedMember";
          })).toBe(false);
          expect(snapshot.state.party.some((entry) => entry.pcId === "p99")).toBe(false);
        } finally {
          restore();
          session.close();
        }
      });
    }
  }
});
