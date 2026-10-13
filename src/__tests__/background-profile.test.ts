import { describe, expect, test } from "bun:test";
import {
  buildBaseBackgroundProfile,
  composeBackstory,
} from "../character/background-profile";
import type { CharacterArchetype } from "../character/character-factory";
import type { BackgroundProfile } from "../character/coc-character";

const profile: BackgroundProfile = {
  appearance: "面容沉静。",
  beliefs: "救人是本分。",
  significantPeople: "护士长。",
  meaningfulPlace: "码头边的诊所。",
  treasuredPossession: "一封写了没寄出的信。",
  traits: "沉静，观察入微。",
  woundsAndScars: "右手背一道旧疤。",
  phobiasAndManias: "怕黑。",
};

describe("background-profile prose fallback", () => {
  test("composes every supplied fact into neutral prose without duplicate stops", () => {
    const story = composeBackstory(profile, {
      name: "艾格尼丝·米切尔",
      occupation: "护士",
      era: "1921",
    });

    for (const fact of Object.values(profile)) expect(story).toContain(fact.slice(0, -1));
    expect(story).toContain("艾格尼丝·米切尔，1921年的护士。");
    expect(story).not.toContain("他");
    expect(story).not.toContain("。。");
  });

  test("keeps custom terms and safely omits empty facts", () => {
    const sparse: BackgroundProfile = {
      ...profile,
      appearance: "",
      beliefs: "",
      significantPeople: "",
      meaningfulPlace: "教堂/码头/图书馆",
      treasuredPossession: "",
      traits: "",
      woundsAndScars: "",
      phobiasAndManias: "",
    };

    expect(composeBackstory(sparse, {
      name: "诺拉",
      occupation: "飞行员",
      era: "1923",
    })).toBe("诺拉，1923年的飞行员。教堂/码头/图书馆。");
    expect(composeBackstory({ ...sparse, meaningfulPlace: "" }, {
      name: "",
      occupation: "",
      era: "",
    })).toBe("");
    expect(composeBackstory({ ...sparse, beliefs: "   ", meaningfulPlace: "  " }, {
      name: "诺拉",
      occupation: "飞行员",
      era: "1923",
    })).toBe("诺拉，1923年的飞行员。");
  });

  test("uses concrete, neutral generic templates deterministically", () => {
    const generic = buildBaseBackgroundProfile({ id: "nurse" } as CharacterArchetype, () => 0.99);
    const story = composeBackstory(generic, {
      name: "艾格尼丝·米切尔",
      occupation: "护士",
      era: "1921",
    });

    expect(generic.meaningfulPlace).toBe("一间安静的街角书店，常在那里想事情。");
    expect(story).not.toContain("他");
    expect(story).not.toContain("教堂/码头/图书馆");
    expect(story).not.toContain("。。");
  });
});
