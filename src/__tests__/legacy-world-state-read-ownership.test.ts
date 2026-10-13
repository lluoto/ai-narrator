import { describe, expect, test } from "bun:test";
import type { ModuleData } from "../module/types";
import { WorldState } from "../world/state";

function makeModule(): ModuleData {
  return {
    id: "ownership-module",
    title: "Ownership module",
    version: "1.0.0",
    ruleset: "cosmic-horror",
    era: "1920s",
    summary: "A deliberately small mutable module fixture.",
    meta: {
      playerCount: "1-2",
      expectedDuration: "1 hour",
      triggerWarnings: [],
    },
    scenes: [
      {
        id: "entry",
        name: "Entry Hall",
        description: "The canonical entry scene.",
        clues: [
          {
            id: "key",
            name: "Brass key",
            description: "A key opens the archive.",
            findMethods: [],
            revelation: "The archive can now be opened.",
            unlocks: ["archive-note"],
            found: false,
            importance: "core",
            setStateVar: { key: "archiveOpen", value: true },
          },
          {
            id: "archive-note",
            name: "Archive note",
            description: "A note waits in the archive.",
            findMethods: [],
            revelation: "The note confirms the signal.",
            unlocks: [],
            found: false,
            importance: "core",
          },
        ],
        npcIds: ["keeper"],
        visibleEntities: ["signal"],
        skillChecks: [{ skill: "Spot Hidden", difficulty: "regular", purpose: "find the key" }],
        connections: [{ targetSceneId: "archive", condition: "walk to the archive" }],
        stateVars: { archiveOpen: false },
      },
      {
        id: "archive",
        name: "Archive",
        description: "The second scene.",
        clues: [],
        npcIds: [],
        connections: [],
      },
    ],
    npcs: [
      {
        id: "keeper",
        name: "Keeper",
        role: "archivist",
        description: "Protects the archive.",
        personality: { traits: ["watchful"], speech: "quiet", attitude: "guarded" },
        knowledge: ["The key opens the archive."],
        secrets: ["The signal is dangerous."],
        sceneId: "entry",
      },
    ],
    endings: [],
    items: [],
    narrative: {
      entities: [{
        id: "signal",
        name: "The signal",
        mentionKeywords: ["signal"],
        sceneId: "entry",
        recognition: "{name} recognizes the signal.",
      }],
    },
  };
}

describe("legacy WorldState read ownership", () => {
  test("takes ownership of the supplied module instead of observing later caller changes", () => {
    const module = makeModule();
    const world = new WorldState(module);

    module.scenes[0]!.name = "outside scene";
    module.scenes[0]!.clues[0]!.unlocks.length = 0;
    module.scenes[0]!.clues[0]!.setStateVar!.value = "outside";
    module.scenes[0]!.stateVars!.archiveOpen = "outside";
    module.npcs[0]!.name = "outside NPC";
    module.npcs[0]!.personality.traits.push("outside trait");
    module.narrative!.entities[0]!.mentionKeywords.push("outside mention");

    expect(world.currentScene?.name).toBe("Entry Hall");
    expect(world.allNpcs[0]?.name).toBe("Keeper");
    expect(world.allNpcs[0]?.personality.traits).toEqual(["watchful"]);
    expect(world.narrativeEntities[0]?.mentionKeywords).toEqual(["signal"]);

    world.discoverClue("key");
    expect(world.isClueFound("archive-note")).toBe(true);
    expect(world.getStateVar("entry", "archiveOpen")).toBe(true);
    expect(world.getKpContext()).toContain("Entry Hall");
    expect(world.getKpContext()).not.toContain("outside scene");
  });

  test("detaches structured public readers and keeps prior views stale", () => {
    const world = new WorldState(makeModule());

    const scene = world.currentScene!;
    const npcs = world.allNpcs;
    const npc = world.getNpc("keeper")!;
    const clues = world.getSceneClues();
    const hints = world.getSkillCheckHints();
    const state = world.getNpcState("keeper")!;

    scene.name = "forged scene";
    scene.connections[0]!.condition = "forged connection";
    npcs[0]!.personality.traits.push("forged trait");
    npc.knowledge.push("forged knowledge");
    clues[0]!.unlocks.length = 0;
    clues[0]!.setStateVar!.value = "forged value";
    hints[0]!.purpose = "forged purpose";
    state.mood = "angry";
    state.relationship = -5;

    world.introduceEntity("signal");
    const entities = world.narrativeEntities;
    const visibleEntities = world.getVisibleEntities();
    const pending = world.getPendingRecognition()!;
    entities[0]!.mentionKeywords.push("forged entity keyword");
    visibleEntities[0]!.name = "forged visible entity";
    pending.recognition = "forged recognition";

    world.discoverClue("key");
    world.setNpcMood("keeper", "friendly");
    world.adjustRelationship("keeper", 2);
    world.meetNpc("keeper");
    const visibleNpcs = world.getVisibleNpcs();
    visibleNpcs[0]!.npc.name = "forged visible NPC";
    visibleNpcs[0]!.state.mood = "fearful";

    expect(world.currentScene?.name).toBe("Entry Hall");
    expect(world.getAvailableConnections()[0]?.condition).toBe("walk to the archive");
    expect(world.allNpcs[0]?.personality.traits).toEqual(["watchful"]);
    expect(world.getNpc("keeper")?.knowledge).toEqual(["The key opens the archive."]);
    expect(world.getSkillCheckHints()[0]?.purpose).toBe("find the key");
    expect(world.isClueFound("archive-note")).toBe(true);
    expect(world.getStateVar("entry", "archiveOpen")).toBe(true);
    expect(world.narrativeEntities[0]?.mentionKeywords).toEqual(["signal"]);
    expect(world.getVisibleEntities()[0]?.name).toBe("The signal");
    expect(world.getPendingRecognition()?.recognition).toBe("{name} recognizes the signal.");
    expect(world.getNpcState("keeper")).toMatchObject({ mood: "friendly", relationship: 2, metCount: 1 });
    expect(state).toMatchObject({ mood: "angry", relationship: -5, metCount: 0 });
    expect(visibleNpcs[0]).toMatchObject({ npc: { name: "forged visible NPC" }, state: { mood: "fearful" } });
  });

  test("returns a deep detached state snapshot", () => {
    const world = new WorldState(makeModule());
    const snapshot = world.getSnapshot();

    snapshot.currentSceneId = "archive";
    snapshot.currentRound = 99;
    snapshot.discoveredClues.add("key");
    snapshot.triggeredEvents.add("forged-event");
    snapshot.npcStates.get("keeper")!.mood = "angry";
    snapshot.sceneHistory.push("forged history");
    snapshot.sceneStateVars.get("entry")!.archiveOpen = "forged";
    snapshot.introducedEntities.add("signal");
    snapshot.recognizedEntities.add("signal");

    expect(world.currentSceneId).toBe("entry");
    expect(world.round).toBe(0);
    expect(world.isClueFound("key")).toBe(false);
    expect(world.getNpcState("keeper")?.mood).toBe("neutral");
    expect(world.getHistorySummary()).toEqual([]);
    expect(world.getStateVar("entry", "archiveOpen")).toBe(false);
    expect(world.isEntityIntroduced("signal")).toBe(false);
    expect(world.isEntityRecognized("signal")).toBe(false);

    const stale = world.getSnapshot();
    world.advanceRound();
    world.moveToScene("archive");
    world.meetNpc("keeper");

    expect(stale).toMatchObject({ currentSceneId: "entry", currentRound: 0, sceneHistory: [] });
    expect(stale.npcStates.get("keeper")?.metCount).toBe(0);
  });
});
