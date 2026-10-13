import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { CareerFileStore } from "../character/career-file";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const repositoryCareerRoot = join(process.cwd(), "data", "careers");

function session(id: string, storage?: { careerRoot?: string }) {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "CareerRoot", undefined, storage);
}

function hasCareerFile(root: string, id: string): boolean {
  const sessionRoot = join(root, id);
  return existsSync(sessionRoot)
    && readdirSync(sessionRoot).filter((name) => name.endsWith(".career.json")).length === 1;
}

describe("GameSession career root isolation", () => {
  it("throws and leaves no Career leaf when the initial write fails before publication", () => {
    const root = mkdtempSync(join(tmpdir(), "career-root-before-write-"));
    const id = `career-root-before-write-${crypto.randomUUID()}`;
    const prototype = CareerFileStore.prototype as unknown as {
      atomicWrite(characterName: string, data: unknown): void;
    };
    const originalAtomicWrite = prototype.atomicWrite;
    prototype.atomicWrite = function (): void {
      throw new Error("injected Career failure before publication");
    };
    try {
      expect(() => new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ghost", undefined, { careerRoot: root }))
        .toThrow("injected Career failure before publication");
      expect(new CareerFileStore(join(root, id)).getSnapshot("Ghost")).toBeNull();
    } finally {
      prototype.atomicWrite = originalAtomicWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an exact Career successor when atomic write reports after publication", () => {
    const root = mkdtempSync(join(tmpdir(), "career-root-post-publish-"));
    const id = `career-root-post-publish-${crypto.randomUUID()}`;
    const prototype = CareerFileStore.prototype as unknown as {
      atomicWrite(characterName: string, data: unknown): void;
    };
    const originalAtomicWrite = prototype.atomicWrite;
    let armed = true;
    prototype.atomicWrite = function (this: CareerFileStore, characterName: string, data: unknown): void {
      originalAtomicWrite.call(this, characterName, data);
      if (armed && characterName === "Ghost") {
        armed = false;
        throw new Error("injected Career failure after publication");
      }
    };
    let session: GameSession | undefined;
    try {
      session = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ghost", undefined, { careerRoot: root });
      const live = JSON.parse(session.careerStore?.exportToJson("Ghost") ?? "null");
      const fresh = new CareerFileStore(join(root, id));
      expect(JSON.parse(fresh.exportToJson("Ghost") ?? "null")).toEqual(live);
      expect(fresh.getSnapshot("Ghost")?.characterName).toBe("Ghost");

      session.close();
      session = undefined;
      expect(JSON.parse(new CareerFileStore(join(root, id)).exportToJson("Ghost") ?? "null")).toEqual(live);
    } finally {
      armed = false;
      prototype.atomicWrite = originalAtomicWrite;
      session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps pre-existing Career entries while an exact base replacement reports after publication", () => {
    const root = mkdtempSync(join(tmpdir(), "career-root-post-publish-existing-"));
    const id = `career-root-post-publish-existing-${crypto.randomUUID()}`;
    const careers = new CareerFileStore(join(root, id));
    careers.saveSnapshot({
      characterName: "Ghost", occupation: "Detective", attributes: { power: 50 }, skills: {},
      san: 50, maxSan: 99, cthulhuMythos: 0, hp: 10, maxHp: 10, creditRating: 20,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const preservedEntry = {
      id: "preserved-entry", characterName: "Ghost", moduleId: "module", moduleName: "Module",
      completedAt: "2025-01-02T00:00:00.000Z", endingId: "survived", endingName: "Survived",
      sanChange: 0, cmChange: 0, reputationChange: 0, skillChanges: [], rewardIds: [], narrative: "Preserved.",
    };
    careers.addEntry(preservedEntry);

    const prototype = CareerFileStore.prototype as unknown as {
      atomicWrite(characterName: string, data: unknown): void;
    };
    const originalAtomicWrite = prototype.atomicWrite;
    let armed = true;
    prototype.atomicWrite = function (this: CareerFileStore, characterName: string, data: unknown): void {
      originalAtomicWrite.call(this, characterName, data);
      if (armed && characterName === "Ghost") {
        armed = false;
        throw new Error("injected Career failure after publication");
      }
    };
    let session: GameSession | undefined;
    try {
      session = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ghost", undefined, { careerRoot: root });
      const fresh = new CareerFileStore(join(root, id));
      const persisted = JSON.parse(fresh.exportToJson("Ghost") ?? "null");
      expect(persisted.entries).toEqual([preservedEntry]);
      expect(persisted.base.createdAt).not.toBe("2025-01-01T00:00:00.000Z");
      expect(persisted).toEqual(JSON.parse(session.careerStore?.exportToJson("Ghost") ?? "null"));
    } finally {
      armed = false;
      prototype.atomicWrite = originalAtomicWrite;
      session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a second pcId that would bind the same Career character name before it mutates the session", () => {
    const root = mkdtempSync(join(tmpdir(), "career-root-duplicate-name-"));
    const id = `career-root-duplicate-name-${crypto.randomUUID()}`;
    const storage = { careerRoot: root };
    const session = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined, storage);
    try {
      const before = session.exportOrdinarySessionSnapshot();
      const careers = new CareerFileStore(join(root, id));
      const careerBefore = careers.exportPortableProjection();

      expect(session.addPartyMember("Ada", "detective")).toEqual({
        rejected: expect.any(String),
        reason: "duplicate_character_name",
      });
      expect(session.exportOrdinarySessionSnapshot()).toEqual(before);
      expect(careers.exportPortableProjection()).toEqual(careerBefore);

      const distinct = session.addPartyMember("Bea", "detective");
      expect(distinct).not.toHaveProperty("rejected");
      expect(session.exportOrdinarySessionSnapshot().state.party.map((member) => member.pcId).sort()).toEqual(["p1", "p2"]);
    } finally {
      session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers storage.careerRoot, then __CAREER_DIR, for creation and legacy stores", async () => {
    const root = mkdtempSync(join(tmpdir(), "career-root-isolation-"));
    const explicitRoot = join(root, "explicit");
    const envRoot = join(root, "environment");
    const explicitId = `career-root-explicit-${crypto.randomUUID()}`;
    const envId = `career-root-env-${crypto.randomUUID()}`;
    const legacyId = `career-root-legacy-${crypto.randomUUID()}`;
    const saveId = `career-root-save-${crypto.randomUUID()}`;
    const repositorySessionDirectories = [explicitId, envId, legacyId, saveId].map((id) => join(repositoryCareerRoot, id));
    if (repositorySessionDirectories.some(existsSync)) throw new Error("test session id unexpectedly collides with existing career data");
    const previous = process.env.__CAREER_DIR;
    let saved: GameSession | null = null;
    process.env.__CAREER_DIR = envRoot;
    try {
      session(explicitId, { careerRoot: explicitRoot });
      expect(hasCareerFile(explicitRoot, explicitId)).toBe(true);
      expect(existsSync(join(envRoot, explicitId))).toBe(false);

      session(envId);
      expect(hasCareerFile(envRoot, envId)).toBe(true);
      expect(existsSync(join(repositoryCareerRoot, envId))).toBe(false);

      const legacy = new GameSession(legacyId, "cosmic-horror", CONFIG);
      await legacy.act("传承列表");
      expect(existsSync(join(envRoot, legacyId))).toBe(true);
      expect(existsSync(join(repositoryCareerRoot, legacyId))).toBe(false);

      saved = new GameSession(saveId, "cosmic-horror", CONFIG);
      expect(saved.careerStore).toBeNull();
      const added = saved.addPartyMember("Career Save", "investigator");
      expect(added).not.toHaveProperty("rejected");
      expect(hasCareerFile(envRoot, saveId)).toBe(true);
      expect(existsSync(join(repositoryCareerRoot, saveId))).toBe(false);
    } finally {
      saved?.close();
      if (previous === undefined) delete process.env.__CAREER_DIR;
      else process.env.__CAREER_DIR = previous;
      rmSync(root, { recursive: true, force: true });
      for (const directory of repositorySessionDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
