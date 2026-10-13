import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import * as careerModel from "../character/career";
import type {
  CharacterCareer,
  CharacterSnapshot,
  CareerEntry,
} from "../character/career";
import { CareerFileStore } from "../character/career-file";
import { importPointsTo, maskSource, scanImports } from "../diagnostics/source-scan";

const CAREER_MODEL = "src/character/career.ts";
const GAME_SESSION = "src/api/game-session.ts";

function source(file: string): string {
  return readFileSync(file, "utf8");
}

function typeWitness(
  snapshot: CharacterSnapshot,
  entry: CareerEntry,
  career: CharacterCareer,
): [CharacterSnapshot, CareerEntry, CharacterCareer] {
  return [snapshot, entry, career];
}

describe("Career storage authority", () => {
  it("keeps career.ts as a type-and-pure-calculation module with no SQLite runtime authority", () => {
    const imports = scanImports(source(CAREER_MODEL));
    const runtime = maskSource(source(CAREER_MODEL)).masked;

    expect(imports.some((entry) => entry.path === "bun:sqlite")).toBe(false);
    expect(runtime).not.toMatch(/\bCareerStore\b/);
    expect(runtime).not.toContain("career.db");
    expect(Object.keys(careerModel).sort()).toEqual(["computeCurrentState", "generateNarrative"]);
  });

  it("preserves the shared model types and pure calculation semantics", () => {
    const snapshot: CharacterSnapshot = {
      characterName: "Authority Investigator",
      occupation: "Detective",
      attributes: { strength: 50 },
      skills: { SpotHidden: 60 },
      san: 50,
      maxSan: 99,
      cthulhuMythos: 0,
      hp: 10,
      maxHp: 10,
      creditRating: 20,
      createdAt: "2026-09-30T00:00:00.000Z",
    };
    const entry: CareerEntry = {
      id: "authority-entry",
      characterName: snapshot.characterName,
      moduleId: "authority-module",
      moduleName: "Authority Module",
      completedAt: "2026-09-30T00:00:00.000Z",
      endingId: "completed",
      endingName: "Completed",
      sanChange: -4,
      cmChange: 5,
      reputationChange: 2,
      skillChanges: ["SpotHidden+d10→70"],
      rewardIds: [],
      narrative: "authority witness",
    };
    const state = careerModel.computeCurrentState(snapshot, [entry]);
    const career: CharacterCareer = {
      characterName: snapshot.characterName,
      base: snapshot,
      entries: [entry],
      totalModules: 1,
      currentSan: state.san,
      currentMaxSan: state.maxSan,
      currentCthulhuMythos: state.cthulhuMythos,
      currentHp: state.hp,
      currentMaxHp: state.maxHp,
      currentSkills: state.skills,
      currentCreditRating: state.creditRating,
    };

    expect(typeWitness(snapshot, entry, career)).toEqual([snapshot, entry, career]);
    expect(state).toMatchObject({ san: 46, maxSan: 94, cthulhuMythos: 5, creditRating: 22 });
    expect(state.skills).toEqual({ SpotHidden: 70 });
    expect(careerModel.generateNarrative(entry.moduleName, entry.endingName, entry.sanChange, entry.cmChange, entry.skillChanges))
      .toContain("Authority Module");
  });

  it("keeps CareerFileStore as the GameSession production persistence class", () => {
    const imports = scanImports(source(GAME_SESSION));
    const runtime = maskSource(source(GAME_SESSION)).masked;

    expect(typeof CareerFileStore).toBe("function");
    expect(imports.some((entry) => importPointsTo(entry.path, "career-file"))).toBe(true);
    expect(imports.some((entry) => importPointsTo(entry.path, "career"))).toBe(false);
    expect(runtime).toMatch(/\bnew\s+CareerFileStore\s*\(/);
  });
});
