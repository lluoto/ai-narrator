import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";
import {
  ordinaryGameSessionSnapshotHash,
  validateOrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
import { CareerFileStore } from "../character/career-file";
import type { CareerEntry, CharacterSnapshot } from "../character/career";

function entry(characterName: string, id: string): CareerEntry {
  return {
    id,
    characterName,
    moduleId: `module-${id}`,
    moduleName: `Module ${id}`,
    completedAt: "2026-09-30T00:00:00.000Z",
    endingId: "completed",
    endingName: "Completed",
    sanChange: 0,
    cmChange: 0,
    reputationChange: 0,
    skillChanges: [],
    rewardIds: [],
    narrative: `Career entry ${id}`,
  };
}

function resign(snapshot: any): any {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

/** This recreates the original v1.1 wire exactly: it has no Career field. */
function asHistoricalV11(snapshot: any): any {
  const historical = structuredClone(snapshot);
  historical.schemaVersion = "1.1.0";
  historical.components.snapshot = "1.1.0";
  historical.state.woundsTreated = false;
  delete historical.state.woundsTreatedByPC;
  delete historical.state.terminal;
  delete historical.components.career;
  delete historical.career;
  return resign(historical);
}

/** v1.0 predates per-PC growth ownership and the complete Career projection. */
function asLegacyV10(snapshot: any): any {
  const legacy = asHistoricalV11(snapshot);
  legacy.schemaVersion = "1.0.0";
  legacy.components.snapshot = "1.0.0";
  legacy.state.skillGrowthMarks = [];
  delete legacy.state.skillGrowthMarksByPC;
  return resign(legacy);
}

function renamedBase(base: CharacterSnapshot, characterName: string): CharacterSnapshot {
  return { ...structuredClone(base), characterName };
}

test("complete career projections preserve every record and replace target-local extras exactly", () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-complete-projection-"));
  const id = "ordinary_career_complete_projection";
  const source = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source") }, undefined, "development_fallback");
  const target = new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined,
    { careerRoot: join(root, "target") }, undefined, "development_fallback");
  try {
    const sourceStore = new CareerFileStore(join(root, "source", id));
    const adaBase = sourceStore.getSnapshot("Ada");
    if (!adaBase) throw new Error("source Ada base is required");
    sourceStore.addEntry(entry("Ada", "source-ada-entry"));
    sourceStore.saveSnapshot(renamedBase(adaBase, "Retired Bea"));
    sourceStore.addEntry(entry("Retired Bea", "source-retired-entry"));

    const targetStore = new CareerFileStore(join(root, "target", id));
    targetStore.saveSnapshot(renamedBase(adaBase, "Target Only"));
    targetStore.addEntry(entry("Target Only", "target-only-entry"));

    const snapshot = source.exportOrdinarySessionSnapshot();
    expect(snapshot.career).toMatchObject({ mode: "complete", projection: { version: 1 } });
    expect(snapshot.career.mode === "complete" ? snapshot.career.projection.records.map((record) => record.characterName) : [])
      .toEqual(["Ada", "Retired Bea"]);

    target.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(targetStore.listCharacters().sort()).toEqual(["Ada", "Retired Bea"]);
    expect(targetStore.getEntries("Ada").map((value) => value.id)).toEqual(["source-ada-entry"]);
    expect(targetStore.getEntries("Retired Bea").map((value) => value.id)).toEqual(["source-retired-entry"]);
    expect(targetStore.getEntries("Target Only")).toEqual([]);
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete career projections reject rehashed malformed, mismatched, and duplicate identities", () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-projection-forgery-"));
  const id = "ordinary_career_projection_forgery";
  const source = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source") }, undefined, "development_fallback");
  try {
    const sourceStore = new CareerFileStore(join(root, "source", id));
    sourceStore.addEntry(entry("Ada", "career-forgery-entry"));
    const original: any = source.exportOrdinarySessionSnapshot();

    const hashTampered = structuredClone(original);
    hashTampered.career.projection.records[0].entries[0].moduleName = "tampered without resigning";
    expect(() => validateOrdinaryGameSessionSnapshot(hashTampered)).toThrow("snapshotHash");

    const identityMismatch = structuredClone(original);
    identityMismatch.career.projection.records[0].entries[0].characterName = "Bea";
    expect(() => validateOrdinaryGameSessionSnapshot(resign(identityMismatch))).toThrow("characterName");

    const duplicatedIdentity = structuredClone(original);
    duplicatedIdentity.career.projection.records.push(structuredClone(duplicatedIdentity.career.projection.records[0]));
    expect(() => validateOrdinaryGameSessionSnapshot(resign(duplicatedIdentity))).toThrow("duplicates characterName");

    const malformed = structuredClone(original);
    malformed.career.projection.records[0].entries[0].completedAt = "not-a-timestamp";
    expect(() => validateOrdinaryGameSessionSnapshot(resign(malformed))).toThrow("completedAt");
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified v1.0 and v1.1 snapshots migrate bases-only and preserve target-local history", () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-career-projection-legacy-"));
  const id = "ordinary_career_projection_legacy";
  const source = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "source") }, undefined, "development_fallback");
  const v11Target = new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined,
    { careerRoot: join(root, "v11-target") }, undefined, "development_fallback");
  const v10Target = new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined,
    { careerRoot: join(root, "v10-target") }, undefined, "development_fallback");
  try {
    const sourceStore = new CareerFileStore(join(root, "source", id));
    const base = sourceStore.getSnapshot("Ada");
    if (!base) throw new Error("source Ada base is required");
    const v11 = asHistoricalV11(source.exportOrdinarySessionSnapshot());
    const v10 = asLegacyV10(source.exportOrdinarySessionSnapshot());
    const migratedV11 = validateOrdinaryGameSessionSnapshot(v11);
    const migratedV10 = validateOrdinaryGameSessionSnapshot(v10);
    expect(migratedV11).toMatchObject({ schemaVersion: "1.4.0", career: { mode: "legacy-bases-only" } });
    expect(migratedV10).toMatchObject({ schemaVersion: "1.4.0", career: { mode: "legacy-bases-only" } });

    for (const [name, target] of [["v11-target", v11Target], ["v10-target", v10Target]] as const) {
      const targetStore = new CareerFileStore(join(root, name, id));
      targetStore.saveSnapshot(renamedBase(base, "Ada"));
      targetStore.addEntry(entry("Ada", `${name}-existing-entry`));
      target.restoreOrdinarySessionSnapshot(name === "v11-target" ? v11 : v10);
      expect(targetStore.getEntries("Ada").map((value) => value.id)).toEqual([`${name}-existing-entry`]);
      const current = target.exportOrdinarySessionSnapshot();
      expect(current.career.mode).toBe("complete");
      expect(current.career.mode === "complete" ? current.career.projection.records[0]?.entries.map((value) => value.id) : [])
        .toEqual([`${name}-existing-entry`]);
    }

    const badHistoricalHash = structuredClone(v11);
    badHistoricalHash.state.round = 7;
    expect(() => validateOrdinaryGameSessionSnapshot(badHistoricalHash)).toThrow("snapshotHash");
  } finally {
    source.close();
    v11Target.close();
    v10Target.close();
    rmSync(root, { recursive: true, force: true });
  }
});
