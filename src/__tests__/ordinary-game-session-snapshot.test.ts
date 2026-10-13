import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession, type ActionResponse } from "../api/game-session";
import { NPCStore } from "../db";
import { npcStoreSnapshotHash } from "../db/npc-store-snapshot";
import {
  normalizeOrdinaryCoCCharacterSheet,
  ordinaryGameSessionSnapshotHash,
  validateOrdinaryGameSessionSnapshot,
  type OrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
import { buildCoCCharacter } from "../character/coc-character";
import { CareerFileStore } from "../character/career-file";
import { getArchetype } from "../character/character-factory";
import { createOrdinarySessionAccessBinding, type OrdinarySessionAccessBinding } from "../api/session-access";
import { worldStateSnapshotHash } from "../state/world-state-snapshot";

/** Compile-only: public action projections must not become writable authority. */
function assertActionResponseTerminalAndDiceAreReadonly(response: ActionResponse): void {
  // @ts-expect-error public terminal projection cannot be rebound
  response.terminal = null;
  // @ts-expect-error public dice projection cannot be rebound
  response.dice = [];
}

function assertTerminalFieldsAreReadonly(
  terminal: Extract<NonNullable<ActionResponse["terminal"]>, { kind: "module_departure" }>,
): void {
  // @ts-expect-error public terminal fields cannot be changed
  terminal.endingId = "forged-ending";
}

function assertDiceEntriesAreReadonly(response: ActionResponse): void {
  if (response.dice) {
    // @ts-expect-error public dice projection cannot be appended to
    response.dice.push({ expr: "d100", total: 1 });
    const roll = response.dice[0];
    if (roll) {
      // @ts-expect-error public dice totals cannot be changed
      roll.total = 1;
    }
  }
}
void assertActionResponseTerminalAndDiceAreReadonly;
void assertTerminalFieldsAreReadonly;
void assertDiceEntriesAreReadonly;

function resign(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function resignWorld(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { hash: _discarded, ...unsigned } = snapshot.world;
  snapshot.world = { ...unsigned, hash: worldStateSnapshotHash(unsigned) };
  return resign(snapshot);
}

function resignNPCStore(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { hash: _discarded, ...unsigned } = snapshot.npcStore;
  snapshot.npcStore = { ...unsigned, hash: npcStoreSnapshotHash(unsigned) };
  return resign(snapshot);
}

function fresh(id: string, archetype?: string, access?: OrdinarySessionAccessBinding): GameSession {
  return new GameSession(id, "cosmic-horror", undefined, archetype, archetype ? "Ada" : undefined, undefined, undefined, access, "development_fallback");
}

it("preserves the CoC damage-table build domain when normalizing ordinary character sheets", () => {
  const archetype = getArchetype("investigator");
  if (!archetype) throw new Error("investigator archetype is required for the snapshot boundary fixture");
  const weak = buildCoCCharacter({
    name: "Ada", archetypeId: archetype.id, method: "point_buy", attributes: {
      strength: 1, constitution: 40, size: 1, dexterity: 40,
      appearance: 40, intelligence: 40, power: 40, education: 40,
    }, includeLuck: false,
  }, archetype);
  const slight = buildCoCCharacter({
    name: "Bea", archetypeId: archetype.id, method: "point_buy", attributes: {
      strength: 40, constitution: 40, size: 40, dexterity: 40,
      appearance: 40, intelligence: 40, power: 40, education: 40,
    }, includeLuck: false,
  }, archetype);

  expect(weak.build).toBe(-2);
  expect(slight.build).toBe(-1);
  expect(normalizeOrdinaryCoCCharacterSheet(weak)).toMatchObject({ build: -2 });
  expect(normalizeOrdinaryCoCCharacterSheet(slight)).toMatchObject({ build: -1 });

  const belowCoCDomain = { ...weak, build: -3 };
  const aboveCoCDomain = { ...weak, build: 9 };
  expect(() => normalizeOrdinaryCoCCharacterSheet(belowCoCDomain)).toThrow("character sheet.build");
  expect(() => normalizeOrdinaryCoCCharacterSheet(aboveCoCDomain)).toThrow("character sheet.build");
});

it("round-trips an ordinary multi-PC session through JSON into a fresh private-store target", async () => {
  const session = new GameSession(
    "ordinary_snapshot_boundary",
    "cosmic-horror",
    undefined,
    "detective",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
  );
  const restored = new GameSession(
    "ordinary_snapshot_boundary",
    "cosmic-horror",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
  );
  try {
    expect(session.addPartyMember("Bea", "detective")).not.toHaveProperty("rejected");
    const snapshot = session.exportOrdinarySessionSnapshot();
    expect(snapshot.kind).toBe("ordinary-game-session");
    const wireSnapshot = JSON.parse(JSON.stringify(snapshot));
    restored.restoreOrdinarySessionSnapshot(wireSnapshot);
    expect(restored.getState()).toEqual(session.getState());
    expect(restored.getOrdinarySessionAccessBinding()).toEqual(session.getOrdinarySessionAccessBinding());

    const afterRestoreAction = await restored.act("状态");
    expect(afterRestoreAction.error).toBeUndefined();
  } finally {
    session.close();
    restored.close();
  }
});

it("round-trips the public pre-character ordinary-session placeholder", () => {
  const source = fresh("ordinary_snapshot_pre_character");
  const target = fresh("ordinary_snapshot_pre_character");
  try {
    const snapshot = source.exportOrdinarySessionSnapshot();
    target.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(target.getState()).toEqual(source.getState());
  } finally {
    source.close();
    target.close();
  }
});

it("rejects an unreferenced player_state before it can seed a future party member", () => {
  const source = fresh("ordinary_snapshot_unreferenced_player_state");
  const target = fresh("ordinary_snapshot_unreferenced_player_state");
  try {
    const forged = structuredClone(source.exportOrdinarySessionSnapshot());
    forged.world.tables.player_state.push({
      rowid: 2,
      entity_id: "p2",
      sanity: null,
      inventory: ["forged future inventory"],
      weapons: ["forged future weapon"],
      armor: ["forged future armor"],
      updated_at: 0,
    });
    const rehashed = resignWorld(forged);

    // addPartyMember allocates p2 next and registerPlayer is intentionally an
    // INSERT OR IGNORE. An unreferenced durable row would therefore survive
    // into a future player unless the envelope identity boundary rejects it.
    expect(() => validateOrdinaryGameSessionSnapshot(rehashed)).toThrow(
      "world player-state identities disagree with PlayerSession",
    );
    expect(() => target.restoreOrdinarySessionSnapshot(rehashed)).toThrow(
      "world player-state identities disagree with PlayerSession",
    );
    expect(target.getState().party).toHaveLength(0);
  } finally {
    source.close();
    target.close();
  }
});

it("keeps canonical inactive PC, SQLite HP, and portable snapshots aligned after KP damage", () => {
  const session = fresh("ordinary_snapshot_damage_truth", "detective");
  try {
    const activeCharacter = session.activeCharacter;
    const activeHp = activeCharacter.hp;
    const added = session.addPartyMember("Bea", "detective");
    expect(added).not.toHaveProperty("rejected");
    if ("rejected" in added) throw new Error(added.rejected);
    const inactiveHp = added.member.sheet.hp;

    expect(session.applyDamage("p1", 2).ok).toBe(true);
    expect(session.applyDamage(added.member.pcId, 1).ok).toBe(true);

    expect(session.getState().player.hp).toBe(activeHp - 2);
    expect(session.getCharacterSummary()?.hp).toBe(activeHp - 2);
    expect(session.activeCharacter).toMatchObject({ hp: activeHp - 2 });
    expect(session.activeCharacter).not.toBe(activeCharacter);
    // addPartyMember returns a detached frozen observation, never a live raw
    // sheet. Retaining it must not give a stale observer write-through/live
    // semantics after KP damage.
    expect(Object.isFrozen(added.member.sheet)).toBe(true);
    expect(added.member.sheet.hp).toBe(inactiveHp);

    const inactiveId = added.member.pcId;
    expect(session.getState().party.find((member) => member.pcId === inactiveId)).toMatchObject({
      hp: inactiveHp - 1,
    });
    expect(session.world.getEntity(inactiveId)).toMatchObject({ hp: inactiveHp - 1 });
    const snapshot = session.exportOrdinarySessionSnapshot();
    expect(snapshot.state.characters.find((entry) => entry.pcId === inactiveId)?.sheet).toMatchObject({
      hp: inactiveHp - 1,
    });
  } finally {
    session.close();
  }
});

it("recreates target-scoped career persistence for restored character sheets", () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-snapshot-career-"));
  const id = "ordinary_snapshot_career";
  const source = new GameSession(
    id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source") }, undefined, "development_fallback",
  );
  const target = new GameSession(
    id, "cosmic-horror", undefined, undefined, undefined, undefined,
    { careerRoot: join(root, "target") }, undefined, "development_fallback",
  );
  try {
    expect(source.careerStore).not.toBeNull();
    const sourceReader = new CareerFileStore(join(root, "source", id));
    const sourceBefore = sourceReader.exportPortableProjection();
    target.restoreOrdinarySessionSnapshot(source.exportOrdinarySessionSnapshot());
    expect(target.careerStore).not.toBeNull();
    const targetReader = new CareerFileStore(join(root, "target", id));
    expect(targetReader.getSnapshot("Ada")?.characterName).toBe("Ada");
    expect(targetReader.exportPortableProjection()).toEqual(sourceBefore);
    expect(sourceReader.exportPortableProjection()).toEqual(sourceBefore);
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("fails stopped when target-local career projection cannot initialize", () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-snapshot-career-failure-"));
  const id = "ordinary_snapshot_career_failure";
  const source = new GameSession(
    id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source") }, undefined, "development_fallback",
  );
  const blockedCareerRoot = join(root, "not-a-directory");
  writeFileSync(blockedCareerRoot, "ordinary snapshot target must not reuse this file", "utf8");
  const target = new GameSession(
    id, "cosmic-horror", undefined, undefined, undefined, undefined,
    { careerRoot: blockedCareerRoot }, undefined, "development_fallback",
  );
  try {
    expect(() => target.restoreOrdinarySessionSnapshot(source.exportOrdinarySessionSnapshot())).toThrow("failed closed");
    expect(() => target.exportOrdinarySessionSnapshot()).toThrow("closed");
    expect(source.careerStore?.getSnapshot("Ada")?.characterName).toBe("Ada");
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects getters, symbols, hidden properties, sparse arrays, and custom prototypes", () => {
  const source = fresh("ordinary_snapshot_hostile", "detective");
  try {
    const getter = structuredClone(source.exportOrdinarySessionSnapshot());
    Object.defineProperty(getter.state, "round", { get: () => 0, enumerable: true, configurable: true });
    expect(() => validateOrdinaryGameSessionSnapshot(getter)).toThrow("data property");

    const symbol = structuredClone(source.exportOrdinarySessionSnapshot());
    Object.defineProperty(symbol, Symbol("ordinary snapshot symbol"), { value: true, enumerable: true });
    expect(() => validateOrdinaryGameSessionSnapshot(symbol)).toThrow("symbols");

    const hidden = structuredClone(source.exportOrdinarySessionSnapshot());
    Object.defineProperty(hidden.state, "hidden", { value: true, enumerable: false });
    expect(() => validateOrdinaryGameSessionSnapshot(hidden)).toThrow("enumerable data property");

    const sparse = structuredClone(source.exportOrdinarySessionSnapshot());
    const characters = [...sparse.state.characters];
    characters.length = 1;
    delete characters[0];
    sparse.state.characters = characters;
    expect(() => validateOrdinaryGameSessionSnapshot(sparse)).toThrow("sparse");

    const prototyped = structuredClone(source.exportOrdinarySessionSnapshot());
    Object.setPrototypeOf(prototyped.state, { poisoned: true });
    expect(() => validateOrdinaryGameSessionSnapshot(prototyped)).toThrow("plain object");
  } finally {
    source.close();
  }
});

it("reinstalls a real legacy module package before applying ordinary dynamic state", async () => {
  const source = fresh("ordinary_snapshot_module", "detective");
  const replacement = fresh("ordinary_snapshot_module");
  const failStopped = fresh("ordinary_snapshot_module");
  try {
    const load = await source.act("加载模组 普瑞米尔的谷仓");
    expect(load.error).toBeUndefined();
    const snapshot = source.exportOrdinarySessionSnapshot();
    expect(snapshot.module.package).not.toBeNull();
    expect(typeof snapshot.npcStore.tables.npc_personalities[0]?.created_at).toBe("number");
    replacement.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(replacement.getState()).toEqual(source.getState());
    expect((await replacement.act("状态")).error).toBeUndefined();

    const staticForgery = structuredClone(snapshot);
    const sceneItems = staticForgery.state.sceneItems[0];
    if (!sceneItems) throw new Error("fixture must install source scene items");
    sceneItems.items.push("forged package item");
    expect(() => failStopped.restoreOrdinarySessionSnapshot(resign(staticForgery))).toThrow("static state disagrees");
    expect(() => failStopped.exportOrdinarySessionSnapshot()).toThrow("closed");
  } finally {
    source.close();
    replacement.close();
    failStopped.close();
  }
});

it("rejects a re-signed registry memory that has no durable NPCStore row before ordinary restore", async () => {
  const id = "ordinary_snapshot_registry_memory_cohort";
  const source = fresh(id, "detective");
  const target = fresh(id);
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const forged = structuredClone(source.exportOrdinarySessionSnapshot());
    const agent = forged.agentRegistry.agents[0];
    if (!agent) throw new Error("real module fixture must register an NPC agent");
    agent.memories.push({
      timestamp: 1_734_000_000_000,
      type: "event",
      content: "registry-only-forgery",
      importance: 5,
    });
    const resigned = resign(forged);
    const targetBefore = target.getState();

    // This is a validly re-signed envelope: the cohort boundary, rather than
    // the outer integrity hash, must reject its non-durable live memory.
    expect(() => validateOrdinaryGameSessionSnapshot(resigned)).toThrow("registry runtime memories");
    expect(() => target.restoreOrdinarySessionSnapshot(resigned)).toThrow("registry runtime memories");
    expect(target.getState()).toEqual(targetBefore);
  } finally {
    source.close();
    target.close();
  }
});

it("allows an active registry cache to be a bounded durable-memory projection", async () => {
  const id = "ordinary_snapshot_registry_memory_projection";
  const source = fresh(id, "detective");
  const target = fresh(id);
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const projected = structuredClone(source.exportOrdinarySessionSnapshot());
    const agent = projected.agentRegistry.agents[0];
    if (!agent) throw new Error("real module fixture must register an NPC agent");
    const personality = projected.npcStore.tables.npc_personalities.find(
      (row) => row.name === agent.personality.name,
    );
    if (!personality) throw new Error("active registry agent must have a persistent personality");
    const memoryId = projected.npcStore.sequences.npc_memories + 1;
    projected.npcStore.tables.npc_memories.push({
      id: memoryId,
      npc_id: personality.id,
      type: "event",
      content: "durable history outside the bounded live cache",
      importance: 5,
      timestamp: 1_734_000_000_000,
      scene_id: "",
      related_entities: [],
      is_summary: 0,
    });
    projected.npcStore.sequences.npc_memories = memoryId;
    const resigned = resignNPCStore(projected);

    expect(validateOrdinaryGameSessionSnapshot(resigned).agentRegistry.agents[0]?.memories)
      .toEqual(agent.memories);
    target.restoreOrdinarySessionSnapshot(resigned);
    expect(target.exportOrdinarySessionSnapshot().npcStore.tables.npc_memories)
      .toContainEqual(expect.objectContaining({ content: "durable history outside the bounded live cache" }));
  } finally {
    source.close();
    target.close();
  }
});

it("requires an optional durable player relationship row to agree with the registry cohort", async () => {
  const id = "ordinary_snapshot_registry_player_relationship_cohort";
  const source = fresh(id, "detective");
  const acceptedTarget = fresh(id);
  const rejectedTarget = fresh(id);
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const coherent = structuredClone(source.exportOrdinarySessionSnapshot());
    const agent = coherent.agentRegistry.agents[0];
    if (!agent) throw new Error("real module fixture must register an NPC agent");
    const personality = coherent.npcStore.tables.npc_personalities.find(
      (row) => row.name === agent.personality.name,
    );
    if (!personality) throw new Error("active registry agent must have a persistent personality");

    agent.relationship = 1;
    agent.playerInteractionCount = 4;
    coherent.npcStore.tables.npc_states = coherent.npcStore.tables.npc_states.filter(
      (row) => row.npc_id !== personality.id,
    );
    coherent.npcStore.tables.npc_relationships = coherent.npcStore.tables.npc_relationships.filter(
      (row) => !(row.npc_id === personality.id && row.target_name === "player"),
    );
    coherent.npcStore.tables.npc_states.push({
      npc_id: personality.id,
      mood: agent.mood,
      relationship: agent.relationship,
      player_interaction_count: agent.playerInteractionCount,
      last_active: 1_734_000_000_000,
    });
    coherent.npcStore.tables.npc_relationships.push({
      npc_id: personality.id,
      target_name: "player",
      relationship: agent.relationship,
      interaction_count: 7,
      last_interaction: 1_734_000_000_000,
    });
    const accepted = resignNPCStore(coherent);
    expect(() => validateOrdinaryGameSessionSnapshot(accepted)).not.toThrow();
    acceptedTarget.restoreOrdinarySessionSnapshot(accepted);

    const drifted = structuredClone(accepted);
    const relationship = drifted.npcStore.tables.npc_relationships.find(
      (row) => row.npc_id === personality.id && row.target_name === "player",
    );
    if (!relationship) throw new Error("fixture must retain its player relationship row");
    relationship.relationship = 2;
    const resignedDrift = resignNPCStore(drifted);
    expect(() => validateOrdinaryGameSessionSnapshot(resignedDrift)).toThrow("player relationship");
    expect(() => rejectedTarget.restoreOrdinarySessionSnapshot(resignedDrift)).toThrow("player relationship");
  } finally {
    source.close();
    acceptedTarget.close();
    rejectedTarget.close();
  }
});

it("rejects a re-signed active registry NPC whose durable row id no longer equals its runtime name", async () => {
  const id = "ordinary_snapshot_registry_durable_identity";
  const source = fresh(id, "detective");
  const target = fresh(id);
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const forged = structuredClone(source.exportOrdinarySessionSnapshot());
    const agent = forged.agentRegistry.agents[0];
    if (!agent) throw new Error("real module fixture must register an NPC agent");
    const personality = forged.npcStore.tables.npc_personalities.find(
      (row) => row.name === agent.personality.name,
    );
    if (!personality) throw new Error("active registry agent must have a persistent personality");
    const originalId = personality.id;
    const forgedId = `${originalId}_forged_durable_identity`;
    personality.id = forgedId;
    for (const table of [
      forged.npcStore.tables.npc_memories,
      forged.npcStore.tables.npc_relationships,
      forged.npcStore.tables.npc_states,
    ]) {
      for (const row of table) if (row.npc_id === originalId) row.npc_id = forgedId;
    }
    const resigned = resignNPCStore(forged);
    const targetBefore = target.getState();

    expect(() => validateOrdinaryGameSessionSnapshot(resigned)).toThrow("durable identity");
    expect(() => target.restoreOrdinarySessionSnapshot(resigned)).toThrow("durable identity");
    expect(target.getState()).toEqual(targetBefore);
  } finally {
    source.close();
    target.close();
  }
});

it("rejects a re-signed nonzero registry relationship when NPCStore has no player relationship row", async () => {
  const id = "ordinary_snapshot_registry_missing_player_relationship";
  const source = fresh(id, "detective");
  const target = fresh(id);
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const forged = structuredClone(source.exportOrdinarySessionSnapshot());
    const agent = forged.agentRegistry.agents[0];
    if (!agent) throw new Error("real module fixture must register an NPC agent");
    const personality = forged.npcStore.tables.npc_personalities.find(
      (row) => row.name === agent.personality.name,
    );
    if (!personality) throw new Error("active registry agent must have a persistent personality");
    agent.relationship = 1;
    agent.playerInteractionCount = 4;
    forged.npcStore.tables.npc_states = forged.npcStore.tables.npc_states.filter(
      (row) => row.npc_id !== personality.id,
    );
    forged.npcStore.tables.npc_relationships = forged.npcStore.tables.npc_relationships.filter(
      (row) => !(row.npc_id === personality.id && row.target_name === "player"),
    );
    forged.npcStore.tables.npc_states.push({
      npc_id: personality.id,
      mood: agent.mood,
      relationship: agent.relationship,
      player_interaction_count: agent.playerInteractionCount,
      last_active: 1_734_000_000_000,
    });
    const resigned = resignNPCStore(forged);
    const targetBefore = target.getState();

    expect(() => validateOrdinaryGameSessionSnapshot(resigned)).toThrow("player relationship");
    expect(() => target.restoreOrdinarySessionSnapshot(resigned)).toThrow("player relationship");
    expect(target.getState()).toEqual(targetBefore);
  } finally {
    source.close();
    target.close();
  }
});

it("allows a nonzero interaction count with zero relationship and no player relationship row", async () => {
  const id = "ordinary_snapshot_registry_zero_missing_player_relationship";
  const source = fresh(id, "detective");
  const target = fresh(id);
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const projected = structuredClone(source.exportOrdinarySessionSnapshot());
    const agent = projected.agentRegistry.agents[0];
    if (!agent) throw new Error("real module fixture must register an NPC agent");
    const personality = projected.npcStore.tables.npc_personalities.find(
      (row) => row.name === agent.personality.name,
    );
    if (!personality) throw new Error("active registry agent must have a persistent personality");
    agent.relationship = 0;
    agent.playerInteractionCount = 1;
    projected.npcStore.tables.npc_states = projected.npcStore.tables.npc_states.filter(
      (row) => row.npc_id !== personality.id,
    );
    projected.npcStore.tables.npc_relationships = projected.npcStore.tables.npc_relationships.filter(
      (row) => !(row.npc_id === personality.id && row.target_name === "player"),
    );
    projected.npcStore.tables.npc_states.push({
      npc_id: personality.id,
      mood: agent.mood,
      relationship: 0,
      player_interaction_count: 1,
      last_active: 1_734_000_000_000,
    });
    const resigned = resignNPCStore(projected);

    expect(() => validateOrdinaryGameSessionSnapshot(resigned)).not.toThrow();
    target.restoreOrdinarySessionSnapshot(resigned);
    expect(target.exportOrdinarySessionSnapshot().agentRegistry.agents[0])
      .toMatchObject({ relationship: 0, playerInteractionCount: 1 });
  } finally {
    source.close();
    target.close();
  }
});

it("rejects re-signed registry mood, relationship, and interaction-count state drift before ordinary restore", async () => {
  const id = "ordinary_snapshot_registry_state_cohort";
  const source = fresh(id, "detective");
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const original = source.exportOrdinarySessionSnapshot();
    const mutations: Array<(agent: typeof original.agentRegistry.agents[number]) => void> = [
      (agent) => { agent.mood = agent.mood === "angry" ? "neutral" : "angry"; },
      (agent) => { agent.relationship = agent.relationship === 0 ? 1 : 0; },
      (agent) => { agent.playerInteractionCount += 1; },
    ];

    for (const mutate of mutations) {
      const forged = structuredClone(original);
      const agent = forged.agentRegistry.agents[0];
      if (!agent) throw new Error("real module fixture must register an NPC agent");
      mutate(agent);
      const resigned = resign(forged);
      const target = fresh(id);
      try {
        const targetBefore = target.getState();
        expect(() => validateOrdinaryGameSessionSnapshot(resigned)).toThrow("registry runtime state");
        expect(() => target.restoreOrdinarySessionSnapshot(resigned)).toThrow("registry runtime state");
        expect(target.getState()).toEqual(targetBefore);
      } finally {
        target.close();
      }
    }
  } finally {
    source.close();
  }
});

it("binds restore to the target session identity, ruleset, and owner access", () => {
  const owner = createOrdinarySessionAccessBinding({ id: "keeper-a", role: "keeper" });
  const source = fresh("ordinary_snapshot_owner", "detective", owner);
  const target = fresh("ordinary_snapshot_owner", undefined, owner);
  try {
    const snapshot = source.exportOrdinarySessionSnapshot();
    const wrongId = structuredClone(snapshot);
    wrongId.session.id = "other-session";
    expect(() => target.restoreOrdinarySessionSnapshot(resign(wrongId))).toThrow("identity");

    const wrongOwner = structuredClone(snapshot);
    wrongOwner.session.access = createOrdinarySessionAccessBinding({ id: "keeper-b", role: "keeper" });
    expect(() => target.restoreOrdinarySessionSnapshot(resign(wrongOwner))).toThrow("owner binding");

    const wrongRuleset = structuredClone(snapshot);
    wrongRuleset.session.ruleset = "dnd5e";
    expect(() => target.restoreOrdinarySessionSnapshot(resign(wrongRuleset))).toThrow("unsupported");
  } finally {
    source.close();
    target.close();
  }
});

it("rejects tampering, component/cross-component mismatches, and module-only state without changing a fresh target", () => {
  const source = fresh("ordinary_snapshot_reject", "detective");
  const target = fresh("ordinary_snapshot_reject");
  try {
    const original = source.exportOrdinarySessionSnapshot();
    const before = target.getState();

    const badHash = structuredClone(original);
    badHash.state.round = 9;
    expect(() => target.restoreOrdinarySessionSnapshot(badHash)).toThrow("snapshotHash");

    const badComponent = structuredClone(original);
    Object.defineProperty(badComponent.world, "schemaVersion", { value: 999, enumerable: true });
    expect(() => target.restoreOrdinarySessionSnapshot(resign(badComponent))).toThrow();

    const crossComponent = structuredClone(original);
    crossComponent.state.activePlayerId = "p2";
    expect(() => target.restoreOrdinarySessionSnapshot(resign(crossComponent))).toThrow("active player");

    const forgedModuleState = structuredClone(original);
    forgedModuleState.state.sceneItems = [{ sceneId: "forged", items: ["forged item"] }];
    expect(() => target.restoreOrdinarySessionSnapshot(resign(forgedModuleState))).toThrow("module-derived state");

    const unknownVersion = structuredClone(original);
    Object.defineProperty(unknownVersion, "schemaVersion", { value: "99.0.0", enumerable: true });
    expect(() => target.restoreOrdinarySessionSnapshot(unknownVersion)).toThrow("unsupported");
    expect(target.getState()).toEqual(before);
  } finally {
    source.close();
    target.close();
  }
});

it("rejects rehashed discoveries that have no ordinary package source", () => {
  const source = fresh("ordinary_snapshot_unbound_clue", "detective");
  const target = fresh("ordinary_snapshot_unbound_clue");
  try {
    const before = target.getState();
    const forged = structuredClone(source.exportOrdinarySessionSnapshot());
    forged.world.tables.clue_discoveries.push({
      rowid: 1,
      player_id: "p1",
      clue_id: "forged_clue_without_module_source",
      discovered_at: Date.now(),
    });
    expect(() => target.restoreOrdinarySessionSnapshot(resignWorld(forged))).toThrow("module-derived");
    expect(target.getState()).toEqual(before);
  } finally {
    source.close();
    target.close();
  }
});

it("rejects a rehashed legacy package snapshot whose source scene drifts", async () => {
  const source = fresh("ordinary_snapshot_scene_source", "detective");
  const target = fresh("ordinary_snapshot_scene_source");
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const forged = structuredClone(source.exportOrdinarySessionSnapshot());
    const scene = forged.world.tables.scenes[0];
    if (!scene) throw new Error("fixture must install a source scene");
    scene.description = "forged scene description without a package source";
    expect(() => target.restoreOrdinarySessionSnapshot(resignWorld(forged))).toThrow("source scene");
    expect(() => target.exportOrdinarySessionSnapshot()).toThrow("closed");
  } finally {
    source.close();
    target.close();
  }
});

it("rejects a rehashed legacy package snapshot whose source NPC statistics drift", async () => {
  const source = fresh("ordinary_snapshot_entity_source", "detective");
  const target = fresh("ordinary_snapshot_entity_source");
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const forged = structuredClone(source.exportOrdinarySessionSnapshot());
    const entity = forged.world.tables.entities.find((candidate) => candidate.type !== "pc");
    if (!entity) throw new Error("fixture must install a source NPC or monster");
    entity.max_hp += 100;
    expect(() => target.restoreOrdinarySessionSnapshot(resignWorld(forged))).toThrow("source entity");
    expect(() => target.exportOrdinarySessionSnapshot()).toThrow("closed");
  } finally {
    source.close();
    target.close();
  }
});

it("allows private default stores but fails closed for in-flight actions and non-pristine targets", async () => {
  const privateDefault = new GameSession("ordinary_snapshot_private_default", "cosmic-horror", undefined, "detective", "Ada", undefined, undefined, undefined, "development_fallback");
  const source = fresh("ordinary_snapshot_pristine", "detective");
  const occupied = fresh("ordinary_snapshot_pristine", "detective");
  try {
    expect(() => privateDefault.exportOrdinarySessionSnapshot()).not.toThrow();

    const snapshot = source.exportOrdinarySessionSnapshot();
    const occupiedBefore = occupied.getState();
    expect(() => occupied.restoreOrdinarySessionSnapshot(snapshot)).toThrow("pristine");
    expect(occupied.getState()).toEqual(occupiedBefore);

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const transaction = source.runExclusiveActionTransaction(async () => {
      entered();
      await releasePromise;
      return null;
    });
    await enteredPromise;
    expect(() => source.exportOrdinarySessionSnapshot()).toThrow("in flight");
    release();
    await transaction;
  } finally {
    privateDefault.close();
    source.close();
    occupied.close();
  }
});

it("fails closed for portable snapshots of a caller-owned NPC store", () => {
  const sharedStore = new NPCStore(":memory:");
  const session = new GameSession(
    "ordinary_snapshot_caller_owned_store",
    "cosmic-horror",
    undefined,
    "detective",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { npcStore: sharedStore },
  );
  try {
    expect(() => session.exportOrdinarySessionSnapshot()).toThrow("private session-owned NPCStore");
    expect(() => session.restoreOrdinarySessionSnapshot({})).toThrow("private session-owned NPCStore");
  } finally {
    session.close();
    sharedStore.close();
  }
});

it("closes the per-session WorldState database with the GameSession", () => {
  const session = fresh("ordinary_snapshot_close_world");
  const world = session.world;
  session.close();
  expect(() => world.exportSnapshot()).toThrow();
});
