import { describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { buildCoCCharacter, getCoCArchetypes, rollCreditRating, rollLuck } from "../character/coc-character";
import { buildBaseBackgroundProfile } from "../character/background-profile";

const fixedRuntime = { characterRandomUnit: () => 0.25 };

function newInvestigator(id: string, runtime = fixedRuntime): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "preferred",
    { ...runtime, careerEntryPersistence: "transient" },
  );
}

describe("GameSession character construction entropy", () => {
  test("validates every direct CoC construction draw without double-calling its source", () => {
    const investigator = getCoCArchetypes().find((archetype) => archetype.id === "investigator");
    if (!investigator) throw new Error("test requires investigator archetype");
    const configuredCharacter = {
      name: "Ada",
      archetypeId: "investigator",
      method: "point_buy" as const,
      includeLuck: false,
      attributes: {
        strength: 50, constitution: 50, size: 50, dexterity: 50,
        appearance: 50, intelligence: 60, power: 50, education: 60,
      },
    };
    const directCalls: Array<(source: () => number) => unknown> = [
      (source) => buildCoCCharacter(configuredCharacter, investigator, source),
      (source) => rollLuck(source),
      (source) => rollCreditRating(undefined, source),
      (source) => buildBaseBackgroundProfile(investigator, source),
    ];

    for (const unit of [Number.NaN, Number.POSITIVE_INFINITY, -0.001, 1]) {
      for (const invoke of directCalls) {
        let draws = 0;
        expect(() => invoke(() => {
          draws++;
          return unit;
        })).toThrow("random unit must be a finite number in [0, 1)");
        expect(draws).toBe(1);
      }
    }
  });

  test("uses a valid trusted source reproducibly across every character draw", () => {
    const first = newInvestigator("character-entropy-fixed-a");
    const second = newInvestigator("character-entropy-fixed-b");

    expect(first.activeCharacter).toEqual(second.activeCharacter);
    expect(first.activeCharacter.backgroundProfile).toBeDefined();
    expect(first.activeCharacter.attributes.power).toBeGreaterThan(0);
  });

  test("rejects non-finite and out-of-unit trusted draws before it can install a card", () => {
    for (const unit of [Number.NaN, Number.POSITIVE_INFINITY, -0.001, 1]) {
      expect(() => newInvestigator(`character-entropy-invalid-${unit}`, {
        characterRandomUnit: () => unit,
      })).toThrow("character construction entropy unit is invalid");
    }
  });

  test("does not disguise a trusted entropy failure as an unknown occupation", async () => {
    const invalidRuntime = { characterRandomUnit: () => Number.NaN };
    const partySession = new GameSession("character-entropy-party", "cosmic-horror", undefined, undefined, undefined, undefined, undefined, undefined, "preferred", { ...invalidRuntime, careerEntryPersistence: "transient" });

    expect(() => partySession.addPartyMember("Bea", "investigator")).toThrow("character construction entropy unit is invalid");
    expect(partySession.session.get("p2")).toBeUndefined();

    const commandSession = new GameSession("character-entropy-command", "cosmic-horror", undefined, undefined, undefined, undefined, undefined, undefined, "preferred", { ...invalidRuntime, careerEntryPersistence: "transient" });
    await expect(commandSession.act("创建角色 investigator Ada")).rejects.toThrow("character construction entropy unit is invalid");
    // The failed direct action has fail-stopped the session.  No dynamic
    // cohort may be inspected after that boundary, including an apparently
    // harmless active-character projection.
    expect(() => commandSession.activeCharacter).toThrow("closed GameSession cannot read session state");
  });

  test("constructs through its canonical entropy source after a same-name runtime shadow", async () => {
    const canonical = newInvestigator("character-entropy-shadow-canonical", {
      characterRandomUnit: () => 0.25,
    });
    const session = new GameSession(
      "character-entropy-shadow-command",
      "cosmic-horror",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "preferred",
      { characterRandomUnit: () => 0.25, careerEntryPersistence: "transient" },
    );
    try {
      Object.defineProperty(session, "characterRandomUnit", {
        configurable: true,
        value: () => 0.99,
      });

      await session.act("\u521b\u5efa\u89d2\u8272 investigator Ada");
      expect(session.activeCharacter).toEqual(canonical.activeCharacter);
    } finally {
      canonical.close();
      session.close();
    }
  });
});
