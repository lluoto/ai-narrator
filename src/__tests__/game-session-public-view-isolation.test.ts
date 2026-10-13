import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryCompanion } from "./helpers/ordinary-companion-fixture";

const LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 256,
  temperature: 0,
};

function ordinarySession(): GameSession {
  return new GameSession(`public-view-${crypto.randomUUID()}`, "cosmic-horror", LLM, "investigator", "View Tester");
}

function ordinaryCompanionSession(): GameSession {
  const session = new GameSession(`public-view-companion-${crypto.randomUUID()}`, "cosmic-horror", LLM);
  restoreSignedOrdinaryCompanion(session, LLM, {
    id: "view-ally",
    name: "View Ally",
    type: "npc",
    behavior: "support",
    hp: 8,
    maxHp: 8,
    ac: 10,
    skills: { fight: 55 },
    damageDice: "1d3",
    inventory: ["flashlight"],
    traits: { courage: 5, aggression: 2, caution: 6, loyalty: 7, cruelty: 1 },
  });
  return session;
}

function requiredSkill(values: Record<string, number>): [string, number] {
  const key = Object.keys(values)[0];
  if (!key) throw new Error("ordinary CoC fixture must create at least one skill");
  return [key, values[key]!];
}

describe("ordinary GameSession public views", () => {
  it("detaches the KP difficulty and character sheets from the live session", () => {
    const session = ordinarySession();
    const changed = session.setDifficulty("hard");
    expect(changed.ok).toBe(true);

    const kp = session.getKPState() as {
      difficulty: { label: string };
      characters: Array<{ attributes: Record<string, number>; skills: Record<string, number> }>;
    };
    const character = kp.characters[0]!;
    const power = character.attributes.power;
    const [skill, skillValue] = requiredSkill(character.skills);

    // The casts model hostile JavaScript callers rather than widening the public API.
    (kp.difficulty as { label: string }).label = "easy";
    (character.attributes as Record<string, number>).power = -999;
    (character.skills as Record<string, number>)[skill] = -999;

    const after = session.getKPState() as typeof kp;
    expect(session.getGateState().variables.difficulty).toBe("hard");
    expect(after.difficulty.label).toBe("hard");
    expect(after.characters[0]!.attributes.power).toBe(power);
    expect(after.characters[0]!.skills[skill]).toBe(skillValue);
  });

  it("detaches the SAN view, including its mutable phobia list", () => {
    const session = ordinarySession();
    const sanity = session.getSanity() as { phobias: string[] };
    const before = [...sanity.phobias];

    sanity.phobias.push("injected-phobia");

    expect(session.getSanity().phobias).toEqual(before);
  });

  it("detaches the ordinary character summary attributes and skills", () => {
    const session = ordinarySession();
    const summary = session.getCharacterSummary() as { attributes: Record<string, number>; skills: Record<string, number> };
    const power = summary.attributes.power;
    const [skill, skillValue] = requiredSkill(summary.skills);

    summary.attributes.power = -999;
    summary.skills[skill] = -999;

    const after = session.getCharacterSummary() as typeof summary;
    expect(after.attributes.power).toBe(power);
    expect(after.skills[skill]).toBe(skillValue);
  });

  it("detaches mutable companion configuration and inventory in the player state view", () => {
    const session = ordinaryCompanionSession();

    const companion = session.getState().companions[0]!;
    companion.inventory.push("injected-item");
    companion.skills!.fight = -999;
    companion.traits!.courage = -999;

    const after = session.getState().companions[0]!;
    expect(after.inventory).toEqual(["flashlight"]);
    expect(after.skills!.fight).toBe(55);
    expect(after.traits!.courage).toBe(5);
  });

  it("detaches ordinary scene-item lists in the KP view", async () => {
    const session = ordinarySession();
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect((await session.act("前往 艾德里安的卧室")).error).toBeUndefined();

    const kp = session.getKPState() as { sceneItems: string[] };
    expect(kp.sceneItems).toContain("老旧文件");
    const before = [...kp.sceneItems];
    kp.sceneItems.push("injected-item");

    expect((session.getKPState() as typeof kp).sceneItems).toEqual(before);
  });

  it("detaches message objects returned by both public history views", () => {
    const session = ordinarySession();
    session.addMessage("KP", "immutable history", "system");

    const history = session.getHistory().messages;
    const playerHistory = session.getPlayerHistory("p1").messages;
    const first = history.find((message) => message.content === "immutable history")!;
    const second = playerHistory.find((message) => message.content === "immutable history")!;

    first.content = "tampered through active history";
    second.speaker = "tampered through player history";

    const afterActive = session.getHistory().messages.find((message) => message.content === "immutable history");
    const afterPlayer = session.getPlayerHistory("p1").messages.find((message) => message.content === "immutable history");
    expect(afterActive?.speaker).toBe("KP");
    expect(afterPlayer?.speaker).toBe("KP");
  });
});
