import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession, runOrdinaryDurableActionTransaction, type GameSessionRuntimeDependencies } from "../api/game-session";
import { NPCStore } from "../db";
import { WorldStateManager } from "../state/world-state-manager";

const CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;

function sessionAt(root: string, id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: root });
}

describe("GameSession CareerFileStore authority", () => {
  it("fails closed and releases its session-owned stores when the initial career root is a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "career-store-construction-failure-"));
    const careerRootFile = join(root, "not-a-career-directory");
    writeFileSync(careerRootFile, "blocking regular file", "utf8");
    const worldClose = WorldStateManager.prototype.close;
    const npcClose = NPCStore.prototype.close;
    let worldCloses = 0;
    let npcCloses = 0;
    WorldStateManager.prototype.close = function (this: WorldStateManager): void {
      worldCloses++;
      return worldClose.call(this);
    };
    NPCStore.prototype.close = function (this: NPCStore): void {
      npcCloses++;
      return npcClose.call(this);
    };
    try {
      expect(() => sessionAt(careerRootFile, "career-store-construction-failure"))
        .toThrow(/career root component .* is not a directory/);
      expect(worldCloses).toBe(1);
      expect(npcCloses).toBe(1);
    } finally {
      WorldStateManager.prototype.close = worldClose;
      NPCStore.prototype.close = npcClose;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for an invalid host-only career entry persistence policy", () => {
    expect(() => new GameSession(
      "career-store-authority-invalid-policy",
      "cosmic-horror",
      CONFIG,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { careerEntryPersistence: "forged" } as unknown as GameSessionRuntimeDependencies,
    )).toThrow("careerEntryPersistence must be durable or transient");
  });

  it("publishes only a frozen null-prototype read facade with detached observations", () => {
    const root = mkdtempSync(join(tmpdir(), "career-store-authority-view-"));
    const session = sessionAt(root, "career-store-authority-view");
    try {
      const store = session.careerStore;
      expect(store).not.toBeNull();
      if (!store) throw new Error("character construction must initialize a career read facade");
      expect(Object.isFrozen(store)).toBe(true);
      expect(Object.getPrototypeOf(store)).toBeNull();
      expect(store).toBe(session.careerStore);

      for (const mutator of [
        "saveSnapshot", "deleteSnapshot", "replacePortableProjection",
        "addEntry", "deleteEntry", "importFromJson",
      ]) {
        expect((store as Record<string, unknown>)[mutator]).toBeUndefined();
      }
      for (const reader of [
        "getSnapshot", "listCharacters", "exportPortableProjection", "getEntries",
        "loadCareer", "listCareers", "exportToJson",
      ]) {
        expect(typeof (store as Record<string, unknown>)[reader]).toBe("function");
      }
      const snapshot = store.getSnapshot("Ada");
      const entries = store.getEntries("Ada");
      const characters = store.listCharacters();
      const projection = store.exportPortableProjection();
      const career = store.loadCareer("Ada");
      const careers = store.listCareers();
      const exportedJson = store.exportToJson("Ada");
      expect(snapshot).not.toBeNull();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot!.skills)).toBe(true);
      expect(Object.isFrozen(entries)).toBe(true);
      expect(Object.isFrozen(characters)).toBe(true);
      expect(characters).toEqual(["Ada"]);
      expect(Object.isFrozen(projection)).toBe(true);
      expect(Object.isFrozen(projection.records)).toBe(true);
      expect(Object.isFrozen(projection.records[0])).toBe(true);
      expect(Object.isFrozen(projection.records[0]!.base)).toBe(true);
      expect(Object.isFrozen(projection.records[0]!.base!.skills)).toBe(true);
      expect(Object.isFrozen(career)).toBe(true);
      expect(Object.isFrozen(career!.base)).toBe(true);
      expect(Object.isFrozen(career!.currentSkills)).toBe(true);
      expect(Object.isFrozen(careers)).toBe(true);
      expect(Object.isFrozen(careers[0])).toBe(true);
      expect(exportedJson).toContain('"characterName": "Ada"');

      const [skill] = Object.keys(snapshot!.skills);
      if (!skill) throw new Error("real fixture must have a base skill");
      const originalSkill = snapshot!.skills[skill];
      expect(Reflect.set(snapshot!.skills, skill, -1)).toBe(false);
      const freshSnapshot = store.getSnapshot("Ada");
      expect(freshSnapshot).not.toBe(snapshot);
      expect(freshSnapshot!.skills[skill]).toBe(originalSkill);
      expect(Reflect.set(store, "forged", true)).toBe(false);

      let assignmentError: unknown;
      try {
        (session as unknown as { careerStore: unknown }).careerStore = { forged: true };
      } catch (error) {
        assignmentError = error;
      }
      expect(assignmentError).toBeInstanceOf(TypeError);
      expect(Reflect.set(session, "careerStore", { forged: true })).toBe(false);
    } finally {
      session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revokes every retained career reader when its owning session closes", () => {
    const root = mkdtempSync(join(tmpdir(), "career-store-closed-facade-"));
    const session = sessionAt(root, "career-store-closed-facade");
    const reader = session.careerStore;
    try {
      expect(reader).not.toBeNull();
      if (!reader) throw new Error("character construction must initialize a career read facade");

      // This confirms the retained facade reaches an actual persisted career record while live.
      expect(reader.getSnapshot("Ada")).toMatchObject({ characterName: "Ada" });

      session.close();
      session.close();
      expect(session.careerStore).toBe(reader);

      const reads = [
        () => reader.getSnapshot("Ada"),
        () => reader.listCharacters(),
        () => reader.exportPortableProjection(),
        () => reader.getEntries("Ada"),
        () => reader.loadCareer("Ada"),
        () => reader.listCareers(),
        () => reader.exportToJson("Ada"),
      ];
      for (const read of reads) {
        expect(read).toThrow("closed GameSession cannot read CareerFileStore");
        expect(read).toThrow("closed GameSession cannot read CareerFileStore");
      }
    } finally {
      session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps canonical career persistence on the private store despite a same-name shadow", () => {
    const root = mkdtempSync(join(tmpdir(), "career-store-authority-shadow-"));
    const session = sessionAt(root, "career-store-authority-shadow");
    try {
      Object.defineProperty(session, "careerStore", {
        configurable: true,
        value: { saveSnapshot: () => { throw new Error("public careerStore shadow was used"); } },
      });

      const added = session.addPartyMember("Bea", "investigator");
      expect(added).not.toHaveProperty("rejected");

      delete (session as unknown as Record<string, unknown>).careerStore;
      const facade = session.careerStore;
      expect(facade?.getSnapshot("Bea")).toMatchObject({ characterName: "Bea" });
    } finally {
      delete (session as unknown as Record<string, unknown>).careerStore;
      session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the host-selected durable departure policy after a same-name runtime shadow", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-store-policy-shadow-"));
    const session = new GameSession(
      "career-store-policy-shadow",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: root },
      undefined,
      "preferred",
      { careerEntryPersistence: "durable", ordinaryDurableHostCapability: durableCareerHostCapability },
    );
    try {
      Object.defineProperty(session, "careerEntryPersistence", {
        configurable: true,
        value: "transient",
      });

      await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
      const requested = await session.act("\u6a21\u7ec4\u7ed3\u7b97");
      expect(requested.narrative).toContain("\u786e\u8ba4\u79bb\u5f00");
      const departed = await runOrdinaryDurableActionTransaction(
        session,
        durableCareerHostCapability,
        async (act) => act("\u786e\u5b9a"),
      );

      expect(departed.terminal).toMatchObject({ kind: "module_departure" });
      expect(session.careerStore?.getEntries("Ada")).toHaveLength(1);
    } finally {
      session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
