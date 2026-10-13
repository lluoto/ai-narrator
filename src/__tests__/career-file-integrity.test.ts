import { describe, expect, it } from "bun:test";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  CareerFileStore,
  validateCareerPortableProjection,
} from "../character/career-file";
import type { CareerEntry, CharacterSnapshot } from "../character/career";

const NAME = "Integrity Investigator";
const MAX_CAREER_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CAREER_COLLECTION_MEMBERS = 4096;
const MAX_IDENTITY_BYTES = 256;
const MAX_FIELD_BYTES = 4096;
const MAX_LONG_TEXT_BYTES = 64 * 1024;

function snapshot(): CharacterSnapshot {
  return {
    characterName: NAME,
    playerName: "Player",
    occupation: "Detective",
    attributes: { strength: 50, intelligence: 70 },
    skills: { SpotHidden: 60 },
    san: 55,
    maxSan: 99,
    cthulhuMythos: 0,
    hp: 11,
    maxHp: 11,
    creditRating: 35,
    createdAt: "2026-01-02T03:04:05.000Z",
    weapons: ["revolver"],
    inventory: ["notebook"],
  };
}

function entry(id = "entry-1"): CareerEntry {
  return {
    id,
    characterName: NAME,
    moduleId: "module-1",
    moduleName: "The First Case",
    completedAt: "2026-01-03T03:04:05.000Z",
    endingId: "survived",
    endingName: "Survived",
    sanChange: -1,
    cmChange: 1,
    reputationChange: 2,
    skillChanges: ["SpotHidden+5"],
    rewardIds: ["reward-1"],
    narrative: "The case is closed.",
  };
}

function careerPath(root: string): string {
  return join(root, "Integrity_Investigator.career.json");
}

function careerFiles(root: string): string[] {
  return readdirSync(root).filter((name) => name.endsWith(".career.json")).sort();
}

function onlyCareerPath(root: string): string {
  const files = careerFiles(root);
  expect(files).toHaveLength(1);
  return join(root, files[0]!);
}

function snapshotFor(characterName: string): CharacterSnapshot {
  return { ...snapshot(), characterName };
}

function entryFor(characterName: string, id: string): CareerEntry {
  return { ...entry(id), characterName };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function detectsSymlinkCapability(type: "file" | "junction"): boolean {
  const root = mkdtempSync(join(tmpdir(), "career-file-symlink-capability-"));
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    if (type === "file") writeFileSync(target, "target", "utf8");
    else mkdirSync(target);
    symlinkSync(target, link, type);
    if (!lstatSync(link).isSymbolicLink()) {
      throw new Error(`${type} symlink capability probe created a non-symlink`);
    }
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") return false;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FILE_SYMLINK_SUPPORTED = detectsSymlinkCapability("file");
const DIRECTORY_LINK_SUPPORTED = detectsSymlinkCapability("junction");

function capture(action: () => void): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectRejectedWithoutRewrite(path: string, action: () => void): void {
  const before = readFileSync(path);
  expect(capture(action)).toBeInstanceOf(Error);
  expect(readFileSync(path)).toEqual(before);
}

function validFile() {
  return {
    version: 1 as const,
    base: snapshot(),
    entries: [entry()],
    updatedAt: "2026-01-03T03:04:05.000Z",
  };
}

function portable(file: ReturnType<typeof validFile>) {
  return {
    version: 1 as const,
    records: [{ characterName: file.base!.characterName, base: file.base, entries: file.entries }],
  };
}

function expectPortableAndImportToAgree(
  store: CareerFileStore,
  file: ReturnType<typeof validFile>,
  expected: "accept" | "reject",
): void {
  const projection = portable(file);
  if (expected === "accept") {
    expect(validateCareerPortableProjection(projection)).toEqual(projection);
    expect(store.importFromJson(JSON.stringify(file))).toBe(true);
  } else {
    expect(() => validateCareerPortableProjection(projection)).toThrow();
    expect(store.importFromJson(JSON.stringify(file))).toBe(false);
  }
}

describe("CareerFileStore integrity boundary", () => {
  it("rejects an oversized existing file before JSON parsing or replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const path = onlyCareerPath(root);
      const validJson = JSON.stringify(validFile());
      writeFileSync(path, `${validJson}${" ".repeat(MAX_CAREER_JSON_BYTES + 1 - Buffer.byteLength(validJson, "utf8"))}`, "utf8");
      expectRejectedWithoutRewrite(path, () => store.addEntry(entry("oversized-existing")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a file which grows after fstat through the bounded fd reader", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const path = onlyCareerPath(root);
      const privateStore = store as unknown as {
        readBoundedUtf8?: (fd: number, maximumBytes: number, context: string) => string;
      };
      const original = privateStore.readBoundedUtf8;
      if (!original) throw new Error("CareerFileStore must expose its bounded fd reader as a private seam");
      let injectedGrowth = false;
      privateStore.readBoundedUtf8 = function (fd, maximumBytes, context): string {
        if (!injectedGrowth && context.includes("career file")) {
          injectedGrowth = true;
          appendFileSync(path, Buffer.alloc(MAX_CAREER_JSON_BYTES, 0x20));
        }
        return original.call(store, fd, maximumBytes, context);
      };
      try {
        expect(capture(() => { store.getSnapshot(NAME); })).toBeInstanceOf(Error);
        expect(injectedGrowth).toBe(true);
      } finally {
        privateStore.readBoundedUtf8 = original;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allocates a bounded reader buffer from the observed file size, not its global ceiling", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const path = onlyCareerPath(root);
      const expectedMaximum = readFileSync(path).byteLength + 1;
      const originalAllocUnsafe = Buffer.allocUnsafe;
      const allocations: number[] = [];
      Buffer.allocUnsafe = ((size: number) => {
        allocations.push(size);
        return originalAllocUnsafe(size);
      }) as typeof Buffer.allocUnsafe;
      try {
        expect(store.getSnapshot(NAME)).toEqual(snapshot());
      } finally {
        Buffer.allocUnsafe = originalAllocUnsafe;
      }
      expect(allocations).toEqual([expectedMaximum]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an invalid UTF-8 byte in an otherwise valid career JSON file", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const path = onlyCareerPath(root);
      const raw = Buffer.from(JSON.stringify(validFile()), "utf8");
      const replacementOffset = raw.indexOf(Buffer.from("Detective", "utf8"));
      if (replacementOffset < 0) throw new Error("invalid UTF-8 fixture must contain the occupation text");
      raw[replacementOffset] = 0xff;
      writeFileSync(path, raw);

      const before = readFileSync(path);
      expect(capture(() => { store.getSnapshot(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.addEntry(entry("invalid-utf8")); })).toBeInstanceOf(Error);
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized JSON imports before parsing and leaves no career file", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      const validJson = JSON.stringify(validFile());
      const oversized = `${validJson}${" ".repeat(MAX_CAREER_JSON_BYTES + 1 - Buffer.byteLength(validJson, "utf8"))}`;
      expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_CAREER_JSON_BYTES);
      expect(store.importFromJson(oversized)).toBe(false);
      expect(careerFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shares bounded record normalization between portable projections and disk imports", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      const boundedEntries = Array.from({ length: MAX_CAREER_COLLECTION_MEMBERS }, (_, index) => entry(`entry-${index}`));
      const entryBoundary = { ...validFile(), entries: boundedEntries };
      expectPortableAndImportToAgree(store, entryBoundary, "accept");
      expect(store.getEntries(NAME)).toHaveLength(MAX_CAREER_COLLECTION_MEMBERS);
      expectPortableAndImportToAgree(store, {
        ...validFile(), entries: [...boundedEntries, entry("entry-overflow")],
      }, "reject");
      expect(store.getEntries(NAME)).toHaveLength(MAX_CAREER_COLLECTION_MEMBERS);

      const boundedArray = Array.from({ length: MAX_CAREER_COLLECTION_MEMBERS }, () => "x");
      expectPortableAndImportToAgree(store, {
        ...validFile(), base: { ...snapshot(), inventory: boundedArray },
      }, "accept");
      expectPortableAndImportToAgree(store, {
        ...validFile(), base: { ...snapshot(), inventory: [...boundedArray, "overflow"] },
      }, "reject");
      expectPortableAndImportToAgree(store, {
        ...validFile(), base: { ...snapshot(), inventory: ["x".repeat(MAX_FIELD_BYTES + 1)] },
      }, "reject");

      const boundedNumberRecord = Object.fromEntries(
        Array.from({ length: MAX_CAREER_COLLECTION_MEMBERS }, (_, index) => [`skill-${index}`, index]),
      );
      expectPortableAndImportToAgree(store, {
        ...validFile(), base: { ...snapshot(), attributes: boundedNumberRecord },
      }, "accept");
      expectPortableAndImportToAgree(store, {
        ...validFile(),
        base: { ...snapshot(), attributes: { ...boundedNumberRecord, overflow: 1 } },
      }, "reject");
      expectPortableAndImportToAgree(store, {
        ...validFile(), base: { ...snapshot(), attributes: { ["k".repeat(MAX_IDENTITY_BYTES + 1)]: 1 } },
      }, "reject");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts exact UTF-8 string limits and rejects overflows in portable and disk data", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      const identity = "i".repeat(MAX_IDENTITY_BYTES);
      const identityBase = snapshotFor(identity);
      const identityEntry = entryFor(identity, "identity-boundary");
      expectPortableAndImportToAgree(store, {
        ...validFile(), base: identityBase, entries: [identityEntry],
      }, "accept");
      const tooLongIdentity = "i".repeat(MAX_IDENTITY_BYTES + 1);
      expectPortableAndImportToAgree(store, {
        ...validFile(), base: snapshotFor(tooLongIdentity), entries: [entryFor(tooLongIdentity, "identity-overflow")],
      }, "reject");

      expectPortableAndImportToAgree(store, {
        ...validFile(), entries: [{ ...entry(), moduleName: "m".repeat(MAX_FIELD_BYTES) }],
      }, "accept");
      expectPortableAndImportToAgree(store, {
        ...validFile(), entries: [{ ...entry(), moduleName: "m".repeat(MAX_FIELD_BYTES + 1) }],
      }, "reject");
      expectPortableAndImportToAgree(store, {
        ...validFile(), entries: [{ ...entry(), moduleName: "🙂".repeat(1025) }],
      }, "reject");

      expectPortableAndImportToAgree(store, {
        ...validFile(),
        base: {
          ...snapshot(),
          notes: "n".repeat(MAX_LONG_TEXT_BYTES),
          description: "d".repeat(MAX_LONG_TEXT_BYTES),
          backstory: "b".repeat(MAX_LONG_TEXT_BYTES),
        },
        entries: [{ ...entry(), narrative: "n".repeat(MAX_LONG_TEXT_BYTES), endingDescription: "e".repeat(MAX_LONG_TEXT_BYTES), rewardSnapshot: "r".repeat(MAX_LONG_TEXT_BYTES) }],
      }, "accept");
      expectPortableAndImportToAgree(store, {
        ...validFile(), entries: [{ ...entry(), narrative: "n".repeat(MAX_LONG_TEXT_BYTES + 1) }],
      }, "reject");
      expectPortableAndImportToAgree(store, {
        ...validFile(), entries: [{ ...entry(), rewardSnapshot: "r".repeat(MAX_LONG_TEXT_BYTES + 1) }],
      }, "reject");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a portable projection whose individually valid records exceed its cumulative byte budget", () => {
    const longNarrative = "n".repeat(MAX_LONG_TEXT_BYTES);
    const records = Array.from({ length: 31 }, (_, index) => {
      const name = `Budget Character ${index}`;
      return {
        characterName: name,
        base: snapshotFor(name),
        entries: [{ ...entryFor(name, `budget-${index}`), narrative: longNarrative }],
      };
    });
    expect(validateCareerPortableProjection({ version: 1, records }).records).toHaveLength(records.length);
    expect(() => validateCareerPortableProjection({
      version: 1,
      records: [...records, {
        characterName: "Budget Character overflow",
        base: snapshotFor("Budget Character overflow"),
        entries: [{ ...entryFor("Budget Character overflow", "budget-overflow"), narrative: longNarrative }],
      }],
    })).toThrow();
  });

  it("streams root enumeration and fails closed above the career-file cap", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      const privateStore = store as unknown as {
        openCareerDirectory?: () => {
          readSync(): { name: string } | null;
          closeSync(): void;
        };
      };
      const original = privateStore.openCareerDirectory;
      if (!original) throw new Error("CareerFileStore must expose its streaming directory opener as a private seam");
      const names = Array.from(
        { length: MAX_CAREER_COLLECTION_MEMBERS + 1 },
        (_, index) => `synthetic-${index}.career.json`,
      );
      let index = 0;
      let closed = false;
      privateStore.openCareerDirectory = () => ({
        readSync: () => index < names.length ? { name: names[index++]! } : null,
        closeSync: () => { closed = true; },
      });
      try {
        expect(capture(() => { store.listCharacters(); })).toBeInstanceOf(Error);
        expect(closed).toBe(true);
      } finally {
        privateStore.openCareerDirectory = original;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a disjoint portable replacement that would exceed a full root inventory before mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const oldPath = onlyCareerPath(root);
      const oldBytes = readFileSync(oldPath);
      const newName = "Disjoint Capacity Investigator";
      const privateStore = store as unknown as {
        openCareerDirectory?: () => {
          readSync(): { name: string } | null;
          closeSync(): void;
        };
      };
      const original = privateStore.openCareerDirectory;
      if (!original) throw new Error("CareerFileStore must expose its streaming directory opener as a private seam");
      const entries = [
        basename(oldPath),
        ...Array.from({ length: MAX_CAREER_COLLECTION_MEMBERS - 1 }, (_, index) => `unrelated-${index}.keep`),
      ];
      let index = 0;
      privateStore.openCareerDirectory = () => ({
        readSync: () => index < entries.length ? { name: entries[index++]! } : null,
        closeSync: () => {},
      });
      try {
        expect(capture(() => store.replacePortableProjection({
          version: 1,
          records: [{ characterName: newName, base: snapshotFor(newName), entries: [] }],
        }))).toBeInstanceOf(Error);
      } finally {
        privateStore.openCareerDirectory = original;
      }
      expect(readFileSync(oldPath)).toEqual(oldBytes);
      expect(store.listCharacters()).toEqual([NAME]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never falls back to legacy leaves when an active pointer names an incomplete staged projection", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const oldPath = onlyCareerPath(root);
      const oldBytes = readFileSync(oldPath);
      const active = "projection-11111111-1111-4111-8111-111111111111";
      mkdirSync(join(root, ".career-projections", active), { recursive: true });
      writeFileSync(join(root, ".career-active.json"), JSON.stringify({
        version: 1,
        active,
        projectionHash: "0".repeat(64),
      }), "utf8");

      expect(capture(() => new CareerFileStore(root).getSnapshot(NAME))).toBeInstanceOf(Error);
      expect(readFileSync(oldPath)).toEqual(oldBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a truncated career file when adding an entry", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      store.addEntry(entry());
      const path = onlyCareerPath(root);
      writeFileSync(path, '{"version":1,"base":', "utf8");

      expectRejectedWithoutRewrite(path, () => store.addEntry(entry("entry-2")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for corrupt public reads", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      writeFileSync(careerPath(root), '{"version":', "utf8");

      expect(capture(() => { store.getSnapshot(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.getEntries(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.loadCareer(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.exportToJson(NAME); })).toBeInstanceOf(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when public enumeration cannot bind file names to validated identities", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      const path = careerPath(root);
      const otherName = "Other Investigator";
      writeFileSync(path, JSON.stringify({
        ...validFile(),
        base: { ...snapshot(), characterName: otherName },
        entries: [{ ...entry(), characterName: otherName }],
      }), "utf8");
      expect(capture(() => { store.listCharacters(); })).toBeInstanceOf(Error);
      expect(capture(() => { store.listCareers(); })).toBeInstanceOf(Error);

      writeFileSync(path, JSON.stringify({ version: 1, base: null, entries: [], updatedAt: "2026-01-03T03:04:05.000Z" }), "utf8");
      expect(capture(() => { store.listCharacters(); })).toBeInstanceOf(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a validated legacy safe-name file readable and writable without silently renaming it", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      const path = careerPath(root);
      writeFileSync(path, JSON.stringify(validFile()), "utf8");

      expect(store.getSnapshot(NAME)).toEqual(snapshot());
      store.addEntry(entry("legacy-entry"));
      expect(careerFiles(root)).toEqual(["Integrity_Investigator.career.json"]);
      expect(store.getEntries(NAME)).toEqual([entry(), entry("legacy-entry")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives formerly colliding logical names distinct files without cross-reading or overwriting", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    const slashName = "Collision/A";
    const colonName = "Collision:A";
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshotFor(slashName));
      store.saveSnapshot(snapshotFor(colonName));
      store.addEntry(entryFor(slashName, "slash-entry"));
      store.addEntry(entryFor(colonName, "colon-entry"));

      expect(careerFiles(root)).toHaveLength(2);
      expect(store.getSnapshot(slashName)?.characterName).toBe(slashName);
      expect(store.getSnapshot(colonName)?.characterName).toBe(colonName);
      expect(store.getEntries(slashName)).toEqual([entryFor(slashName, "slash-entry")]);
      expect(store.getEntries(colonName)).toEqual([entryFor(colonName, "colon-entry")]);
      expect(store.listCharacters().sort()).toEqual([colonName, slashName].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed rather than choosing between new and legacy files for one identity", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const currentPath = onlyCareerPath(root);
      expect(currentPath).not.toBe(careerPath(root));
      writeFileSync(careerPath(root), JSON.stringify(validFile()), "utf8");

      expect(capture(() => { store.getSnapshot(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.listCharacters(); })).toBeInstanceOf(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses malformed, unsupported, and wrong-identity existing files without replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      const path = careerPath(root);
      const cases: Array<{ file: unknown; action: () => void }> = [
        { file: { ...validFile(), version: 2 }, action: () => store.saveSnapshot(snapshot()) },
        { file: { ...validFile(), base: [] }, action: () => store.addEntry(entry("entry-2")) },
        { file: { ...validFile(), updatedAt: 42 }, action: () => store.addEntry(entry("entry-2")) },
        { file: { ...validFile(), entries: [entry(), entry()] }, action: () => store.addEntry(entry("entry-2")) },
        {
          file: { ...validFile(), base: { ...snapshot(), characterName: "Other Investigator" } },
          action: () => store.saveSnapshot(snapshot()),
        },
        {
          file: { ...validFile(), entries: [{ ...entry(), characterName: "Other Investigator" }] },
          action: () => store.addEntry(entry("entry-2")),
        },
      ];

      for (const testCase of cases) {
        writeFileSync(path, JSON.stringify(testCase.file), "utf8");
        expectRejectedWithoutRewrite(path, testCase.action);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips valid v1 data, validates caller input, and leaves no private temp files", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      const base = snapshot();
      const first = entry();
      store.saveSnapshot(base);
      store.addEntry(first);

      expect(store.getSnapshot(NAME)).toEqual(base);
      expect(store.getEntries(NAME)).toEqual([first]);
      expect(store.loadCareer(NAME)?.entries).toEqual([first]);
      expect(store.exportToJson(NAME)).not.toBeNull();
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(capture(() => store.saveSnapshot({ ...base, san: Number.NaN }))).toBeInstanceOf(Error);
      expect(capture(() => store.saveSnapshot({ ...base, characterName: "   " }))).toBeInstanceOf(Error);
      expect(capture(() => store.addEntry({ ...first, id: "non-finite", cmChange: Number.POSITIVE_INFINITY }))).toBeInstanceOf(Error);
      expect(capture(() => store.addEntry({ ...first, id: "", moduleId: "", endingId: "", completedAt: "not-a-time" }))).toBeInstanceOf(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an exact post-publication successor for adjacent entry writes", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-post-publish-entry-"));
    const store = new CareerFileStore(root);
    const privatePrototype = CareerFileStore.prototype as unknown as {
      atomicWrite(characterName: string, data: unknown): void;
    };
    const originalAtomicWrite = privatePrototype.atomicWrite;
    let armed = true;
    try {
      store.saveSnapshot(snapshot());
      privatePrototype.atomicWrite = function (this: CareerFileStore, characterName: string, data: unknown): void {
        originalAtomicWrite.call(this, characterName, data);
        if (armed && characterName === NAME) {
          armed = false;
          throw new Error("injected entry write failure after publication");
        }
      };
      const expected = entry("post-publish-entry");
      expect(() => store.addEntry(expected)).not.toThrow();
      expect(new CareerFileStore(root).getEntries(NAME)).toEqual([expected]);
    } finally {
      armed = false;
      privatePrototype.atomicWrite = originalAtomicWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a different successor when post-publication readback cannot prove identity", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-post-publish-different-"));
    const store = new CareerFileStore(root);
    const privatePrototype = CareerFileStore.prototype as unknown as {
      atomicWrite(characterName: string, data: unknown): void;
    };
    const originalAtomicWrite = privatePrototype.atomicWrite;
    let armed = true;
    try {
      store.saveSnapshot(snapshot());
      privatePrototype.atomicWrite = function (this: CareerFileStore, characterName: string, data: unknown): void {
        originalAtomicWrite.call(this, characterName, data);
        if (armed && characterName === NAME) {
          armed = false;
          const successor = data as { base: CharacterSnapshot | null } & Record<string, unknown>;
          originalAtomicWrite.call(this, characterName, {
            ...successor,
            base: successor.base === null ? null : { ...successor.base, san: 17 },
          });
          throw new Error("injected post-publication different successor");
        }
      };
      expect(() => store.saveSnapshot({ ...snapshot(), san: 61 })).toThrow("injected post-publication different successor");
      expect(new CareerFileStore(root).getSnapshot(NAME)?.san).toBe(17);
    } finally {
      armed = false;
      privatePrototype.atomicWrite = originalAtomicWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes identical entry retries a no-op and rejects conflicting duplicate IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const first = entry();
      store.addEntry(first);
      const path = onlyCareerPath(root);
      const beforeRetry = readFileSync(path);

      store.addEntry({ ...first, skillChanges: [...first.skillChanges], rewardIds: [...first.rewardIds] });
      expect(readFileSync(path)).toEqual(beforeRetry);
      expectRejectedWithoutRewrite(path, () => store.addEntry({ ...first, narrative: "Conflicting replay" }));
      expect(store.getEntries(NAME)).toEqual([first]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function assertLinkTargetIsNeverFollowed(type: "file" | "junction"): void {
    const root = mkdtempSync(join(tmpdir(), "career-file-integrity-"));
    const outside = mkdtempSync(join(tmpdir(), "career-file-outside-"));
    try {
      const store = new CareerFileStore(root);
      store.saveSnapshot(snapshot());
      const path = onlyCareerPath(root);
      rmSync(path);

      const sentinel = join(outside, "outside-sentinel");
      const target = type === "file" ? join(outside, "outside.career.json") : outside;
      if (type === "file") writeFileSync(target, "outside file must survive", "utf8");
      writeFileSync(sentinel, "outside directory must survive", "utf8");
      symlinkSync(target, path, type);
      const before = type === "file" ? readFileSync(target) : readFileSync(sentinel);

      expect(capture(() => { store.getSnapshot(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.getEntries(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.loadCareer(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.exportToJson(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.listCharacters(); })).toBeInstanceOf(Error);
      expect(capture(() => { store.saveSnapshot({ ...snapshot(), san: 54 }); })).toBeInstanceOf(Error);
      expect(capture(() => { store.addEntry(entry("blocked-link-entry")); })).toBeInstanceOf(Error);
      expect(capture(() => { store.deleteSnapshot(NAME); })).toBeInstanceOf(Error);
      expect(capture(() => { store.deleteEntry("blocked-link-entry"); })).toBeInstanceOf(Error);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(type === "file" ? readFileSync(target) : readFileSync(sentinel)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }

  it.skipIf(!FILE_SYMLINK_SUPPORTED)("rejects a root file symlink before every public read, list, or write", () => {
    assertLinkTargetIsNeverFollowed("file");
  });

  it.skipIf(!DIRECTORY_LINK_SUPPORTED)("rejects a root directory junction before every public read, list, or write", () => {
    assertLinkTargetIsNeverFollowed("junction");
  });

  it.skipIf(!DIRECTORY_LINK_SUPPORTED)("rejects a supplied root that is itself a directory junction", () => {
    const parent = mkdtempSync(join(tmpdir(), "career-file-root-link-"));
    const outside = mkdtempSync(join(tmpdir(), "career-file-outside-"));
    try {
      const sentinel = join(outside, "outside-sentinel");
      writeFileSync(sentinel, "outside directory must survive", "utf8");
      const linkedRoot = join(parent, "linked-root");
      symlinkSync(outside, linkedRoot, "junction");

      expect(capture(() => { new CareerFileStore(linkedRoot); })).toBeInstanceOf(Error);
      expect(readFileSync(sentinel, "utf8")).toBe("outside directory must survive");
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
