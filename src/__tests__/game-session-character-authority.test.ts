import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";

const CONFIG = {
  apiKey: "sk-character-authority-test",
  baseUrl: "http://character-authority.invalid/v1",
  model: "character-authority-test",
  maxTokens: 32,
  temperature: 0,
};

const keeper: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "keeper:character-authority" },
});

const liveRegistries: Array<Map<string, GameSession>> = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const registry of liveRegistries.splice(0)) {
    for (const session of registry.values()) session.close();
    registry.clear();
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function runtime(): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  liveRegistries.push(registry);
  return {
    registry,
    dependencies: {
      registry,
      ordinaryIntentPolicy: "development_fallback",
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "offline opening";
        return session;
      },
    },
  };
}

async function request(root: string, setup: ReturnType<typeof runtime>, path: string, init: RequestInit): Promise<Response> {
  return handleRequest(
    new Request(`http://character-authority.test${path}`, init),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {},
    {},
    keeper,
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    setup.dependencies,
  );
}

async function ordinaryHttpFixture(): Promise<{ id: string; session: GameSession; root: string; setup: ReturnType<typeof runtime> }> {
  const root = mkdtempSync(join(tmpdir(), "character-authority-"));
  temporaryRoots.push(root);
  const setup = runtime();
  const created = await request(root, setup, "/api/sessions", json({
    ruleset: "cosmic-horror",
    archetype: "investigator",
    characterName: "Ada",
  }));
  expect(created.status).toBe(201);
  const id = (await created.json() as { sessionId: string }).sessionId;
  const session = setup.registry.get(id);
  if (!session) throw new Error("ordinary HTTP fixture did not install its session");
  return { id, session, root, setup };
}

describe("GameSession character authority", () => {
  it("returns a detached, recursively frozen party sheet that cannot write through", () => {
    const session = new GameSession(`party-sheet-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const joined = session.addPartyMember("Bea", "investigator");
      if ("rejected" in joined) throw new Error(joined.rejected);
      const publicSheet = joined.member.sheet as {
        attributes: { power: number };
        skillValues: Record<string, number>;
        startingItems: string[];
        hp: number;
      };
      const originalPower = publicSheet.attributes.power;
      const [skill, originalSkill] = Object.entries(publicSheet.skillValues)[0]!;
      const originalItems = [...publicSheet.startingItems];

      expect(Object.isFrozen(publicSheet)).toBe(true);
      expect(Object.isFrozen(publicSheet.attributes)).toBe(true);
      expect(() => { publicSheet.attributes.power = -999; }).toThrow();
      expect(() => { publicSheet.skillValues[skill] = -999; }).toThrow();
      expect(() => { publicSheet.startingItems.push("forged"); }).toThrow();

      const snapshot = session.exportOrdinarySessionSnapshot();
      const p2 = snapshot.state.characters.find((entry) => entry.pcId === joined.member.pcId)?.sheet as {
        attributes: { power: number };
        skillValues: Record<string, number>;
        startingItems: string[];
      };
      expect(p2.attributes.power).toBe(originalPower);
      expect(p2.skillValues[skill]).toBe(originalSkill);
      expect(p2.startingItems).toEqual(originalItems);

      const updated = session.updateCharacter(joined.member.pcId, { hp: publicSheet.hp - 1 });
      expect(updated).toMatchObject({ status: "updated", character: { hp: publicSheet.hp - 1 } });
      // A retained observation is neither writable nor a live alias.
      expect(publicSheet.hp).not.toBe(updated.status === "updated" ? updated.character.hp : undefined);
    } finally {
      session.close();
    }
  });

  it("keeps the canonical character map out of runtime reflection and ignores a same-name shadow", () => {
    const session = new GameSession(`character-private-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const hostile = session as unknown as Record<string, unknown>;
      expect(Reflect.ownKeys(session)).not.toContain("characters");
      expect(hostile.characters).toBeUndefined();
      hostile.characters = new Map([["p1", { hp: 1, maxHp: 1, name: "shadow" }]]);
      expect(session.activeCharacter.name).toBe("Ada");
      expect(session.getState().player.name).toBe("Ada");
    } finally {
      session.close();
    }
  });

  it("uses the canonical write API and reflects the new frozen read", () => {
    const session = new GameSession(`character-write-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const before = session.activeCharacter;
      const result = session.updateActiveCharacter({
        hp: before.hp - 1,
        maxHp: before.maxHp,
        skillValues: { spot_hidden: 61 },
        luck: 42,
        creditRating: 33,
        attributes: { power: 55 },
      });
      expect(result).toMatchObject({ status: "updated", character: { hp: before.hp - 1, maxHp: before.maxHp, luck: 42, attributes: { power: 55 }, skillValues: { spot_hidden: 61 } } });
      if (result.status !== "updated") throw new Error(result.code);
      expect(Object.isFrozen(result.character)).toBe(true);
      expect(Object.isFrozen(result.character.attributes)).toBe(true);
      expect(session.activeCharacter.hp).toBe(before.hp - 1);
      expect(session.world.getEntity("p1")?.hp).toBe(before.hp - 1);
      expect(session.world.getEntity("p1")?.maxHp).toBe(before.maxHp);
    } finally {
      session.close();
    }
  });

  it("spends luck through canonical authority and never writes the public view", () => {
    const session = new GameSession(`character-luck-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const before = session.activeCharacter.luck;
      const result = session.spendActiveCharacterLuck(1);
      expect(result).toMatchObject({ status: "updated", character: { luck: before - 1 } });
      expect(session.activeCharacter.luck).toBe(before - 1);
    } finally {
      session.close();
    }
  });

  it("rejects malformed patches before changing either canonical character or world HP", () => {
    const session = new GameSession(`character-invalid-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const before = session.activeCharacter;
      const beforeWorld = session.world.getEntity("p1")!;
      expect(session.updateActiveCharacter({ hp: before.hp - 1, luck: Number.POSITIVE_INFINITY })).toEqual({ status: "refused", code: "character_luck_invalid" });
      expect(session.updateActiveCharacter({ hp: before.hp - 1, unrecognized: 1 } as any)).toEqual({ status: "refused", code: "character_update_invalid" });
      expect(session.updateActiveCharacter({ attributes: { forged: 10 } })).toEqual({ status: "refused", code: "character_attributes_invalid" });
      expect(session.updateCharacter("missing-pc", { hp: 1 })).toEqual({ status: "refused", code: "unknown_pc" });
      expect(session.spendCharacterLuck("missing-pc", 1)).toEqual({ status: "refused", code: "unknown_pc" });
      expect(session.spendActiveCharacterLuck(0)).toEqual({ status: "refused", code: "luck_amount_invalid" });
      expect(session.spendActiveCharacterLuck(before.luck + 1)).toEqual({ status: "refused", code: "luck_insufficient" });
      expect(session.activeCharacter).toMatchObject({ hp: before.hp, maxHp: before.maxHp, luck: before.luck });
      expect(session.world.getEntity("p1")).toMatchObject({ hp: beforeWorld.hp, maxHp: beforeWorld.maxHp });
    } finally {
      session.close();
    }
  });

  it("rejects outer accessor patches without reading caller-controlled values", () => {
    const session = new GameSession(`character-accessor-outer-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const before = session.activeCharacter;
      const beforeWorld = session.world.getEntity("p1")!;
      let reads = 0;
      const patch: Record<string, unknown> = {};
      Object.defineProperty(patch, "luck", {
        enumerable: true,
        get: () => {
          reads++;
          return reads === 1 ? 42 : Number.POSITIVE_INFINITY;
        },
      });

      expect(session.updateActiveCharacter(patch as any)).toEqual({ status: "refused", code: "character_update_invalid" });
      expect(reads).toBe(0);
      expect(session.activeCharacter).toMatchObject({ hp: before.hp, maxHp: before.maxHp, luck: before.luck });
      expect(session.world.getEntity("p1")).toMatchObject({ hp: beforeWorld.hp, maxHp: beforeWorld.maxHp });
    } finally {
      session.close();
    }
  });

  it("fails closed when outer or nested patch reflection throws before any mutation", () => {
    const session = new GameSession(`character-proxy-reflection-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const before = session.activeCharacter;
      const beforeWorld = session.world.getEntity("p1")!;
      const throwingPrototype = <T extends object>(target: T): T => new Proxy(target, {
        getPrototypeOf: () => { throw new Error("caller prototype trap"); },
      });
      const patches = [
        throwingPrototype({ luck: 42 }),
        { skillValues: throwingPrototype({ spot_hidden: 61 }) },
        { attributes: throwingPrototype({ power: 55 }) },
      ];

      for (const patch of patches) {
        let result: ReturnType<GameSession["updateActiveCharacter"]> | undefined;
        expect(() => { result = session.updateActiveCharacter(patch as any); }).not.toThrow();
        expect(result).toEqual({ status: "refused", code: "character_update_invalid" });
        expect(session.activeCharacter).toEqual(before);
        expect(session.world.getEntity("p1")).toEqual(beforeWorld);
      }
    } finally {
      session.close();
    }
  });

  it("rejects nested accessors before they can affect a skill patch", () => {
    const session = new GameSession(`character-accessor-nested-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const before = session.activeCharacter;
      let reads = 0;
      const skills: Record<string, unknown> = {};
      Object.defineProperty(skills, "spot_hidden", {
        enumerable: true,
        get: () => {
          reads++;
          return 61;
        },
      });

      expect(session.updateActiveCharacter({ skillValues: skills as Record<string, number> })).toEqual({ status: "refused", code: "character_update_invalid" });
      expect(reads).toBe(0);
      expect(session.activeCharacter.skillValues.spot_hidden).toBe(before.skillValues.spot_hidden);
    } finally {
      session.close();
    }
  });

  it("rejects nested enumerable symbols rather than spreading them into canonical state", () => {
    const session = new GameSession(`character-symbol-nested-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const before = session.activeCharacter;
      const symbol = Symbol("forged-skill");
      const skills: Record<string | symbol, number> = { spot_hidden: 61 };
      Object.defineProperty(skills, symbol, { enumerable: true, value: 100 });

      expect(session.updateActiveCharacter({ skillValues: skills as Record<string, number> })).toEqual({ status: "refused", code: "character_update_invalid" });
      expect(Object.getOwnPropertySymbols(skills)).toEqual([symbol]);
      expect(session.activeCharacter.skillValues.spot_hidden).toBe(before.skillValues.spot_hidden);
    } finally {
      session.close();
    }
  });

  it("limits CoC-only patches and luck spending by the active ruleset while retaining portable HP patches", () => {
    for (const ruleset of ["dnd5e", "grail"] as const) {
      const session = new GameSession(`character-ruleset-domain-${ruleset}-${crypto.randomUUID()}`, ruleset, CONFIG, "fighter", "Ada");
      try {
        const before = session.activeCharacter;
        const beforeWorld = session.world.getEntity("p1")!;
        expect(session.updateActiveCharacter({ hp: before.hp - 1, luck: 42 })).toEqual({ status: "refused", code: "character_ruleset_unsupported" });
        expect(session.activeCharacter.hp).toBe(before.hp);
        expect(session.world.getEntity("p1")?.hp).toBe(beforeWorld.hp);

        const hpOnly = session.updateActiveCharacter({ hp: before.hp - 1, maxHp: before.maxHp });
        expect(hpOnly).toMatchObject({ status: "updated", character: { hp: before.hp - 1, maxHp: before.maxHp } });
        expect(session.world.getEntity("p1")).toMatchObject({ hp: before.hp - 1, maxHp: before.maxHp });
        expect(session.spendActiveCharacterLuck(1)).toEqual({ status: "refused", code: "luck_ruleset_unsupported" });
      } finally {
        session.close();
      }
    }
  });

  it("refuses explicit character writes after actual compiled-module admission", async () => {
    const session = new GameSession(`character-compiled-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const fixture = await compiledModuleHttpFixture("character-authority-compiled");
      const root = mkdtempSync(join(tmpdir(), "character-authority-compiled-"));
      temporaryRoots.push(root);
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      expect(session.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      expect(session.updateActiveCharacter({ hp: 1 })).toEqual({ status: "refused", code: "compiled_mutation_unsupported" });
      expect(session.spendActiveCharacterLuck(1)).toEqual({ status: "refused", code: "compiled_mutation_unsupported" });
    } finally {
      session.close();
    }
  });

  it("rejects a legacy HTTP character payload without a durable contract or any live/persisted write", async () => {
    const { id, session, root, setup } = await ordinaryHttpFixture();
    const before = session.activeCharacter;
    const beforeWorld = session.world.getEntity("p1");
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
    const character = await request(root, setup, `/api/sessions/${id}/character`, json({ hp: before.hp - 1 }));
    expect(character.status).toBe(400);
    expect(await character.json()).toMatchObject({ code: "ordinary_character_contract_required" });
    expect(session.activeCharacter).toEqual(before);
    expect(session.world.getEntity("p1")).toEqual(beforeWorld);
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
  });
});
