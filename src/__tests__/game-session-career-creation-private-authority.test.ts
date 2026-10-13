import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";
import { CareerFileStore } from "../character/career-file";

const CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid/v1",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

const CAREER_HELPERS = [
  "persistCareerSnapshot",
  "ensureCareerStore",
  "careerSessionDirectory",
] as const;

type CareerHelper = typeof CAREER_HELPERS[number];
type DecoyMode = "fake" | "throw";

type InstalledDecoy = Readonly<{
  calls: () => number;
  invokeArguments: () => unknown[];
  restore: () => void;
}>;

function runtime(durable: "default" | "explicit") {
  return {
    characterRandomUnit: () => 0.25,
    ...(durable === "explicit" ? { careerEntryPersistence: "durable" as const } : {}),
  };
}

function installCareerHelperDecoy(
  target: object,
  helper: CareerHelper,
  mode: DecoyMode,
  divertedRoot: string,
): InstalledDecoy {
  const original = Object.getOwnPropertyDescriptor(target, helper);
  const invocations: unknown[][] = [];
  const fakeStore = Object.freeze({
    saveSnapshot: (...args: unknown[]) => { invocations.push(args); },
  });
  const decoy = (...args: unknown[]): unknown => {
    invocations.push(args);
    if (mode === "throw") throw new Error(`FORGED_${helper}`);
    switch (helper) {
      case "ensureCareerStore": return fakeStore;
      case "careerSessionDirectory": return divertedRoot;
      case "persistCareerSnapshot": return undefined;
    }
  };
  Object.defineProperty(target, helper, { configurable: true, value: decoy });
  return Object.freeze({
    calls: () => invocations.length,
    invokeArguments: () => invocations.flat(),
    restore: () => {
      if (original) Object.defineProperty(target, helper, original);
      else Reflect.deleteProperty(target, helper);
    },
  });
}

function directDecoyCall(session: GameSession, helper: CareerHelper): unknown {
  switch (helper) {
    case "persistCareerSnapshot": return (session as any)[helper]({ name: "Forged" }, {});
    case "ensureCareerStore": return (session as any)[helper]();
    case "careerSessionDirectory": return (session as any)[helper]();
  }
}

function expectDirectDecoyControl(
  session: GameSession,
  helper: CareerHelper,
  mode: DecoyMode,
  decoy: InstalledDecoy,
): void {
  const before = decoy.calls();
  const invoke = () => directDecoyCall(session, helper);
  if (mode === "throw") expect(invoke).toThrow(`FORGED_${helper}`);
  else expect(invoke).not.toThrow();
  expect(decoy.calls()).toBeGreaterThan(before);
}

function expectCanonicalCareerSnapshot(
  root: string,
  id: string,
  name: string,
  session: GameSession,
  pcId: string,
): void {
  const exported = session.exportOrdinarySessionSnapshot();
  const character = exported.state.characters.find((entry) => entry.pcId === pcId);
  const party = exported.state.party.find((entry) => entry.pcId === pcId);
  if (!character || !party) throw new Error(`canonical ${pcId} installation is required`);
  const sheet = character.sheet as { name?: unknown; hp?: unknown; maxHp?: unknown; attributes?: unknown };
  expect(sheet.name).toBe(name);
  expect(party).toMatchObject({ pcId });
  expect(session.session.get(pcId)).toBeDefined();
  expect(session.world.getPlayerIds()).toContain(pcId);
  expect(session.world.getEntity(pcId)).toMatchObject({ id: pcId, name });
  expect(new CareerFileStore(join(root, id)).getSnapshot(name)).toMatchObject({
    characterName: name,
    attributes: sheet.attributes,
    hp: sheet.hp,
    maxHp: sheet.maxHp,
  });
}

describe("GameSession career creation helper private authority", () => {
  for (const helper of CAREER_HELPERS) {
    for (const mode of ["fake", "throw"] as const) {
      it(`keeps a prototype ${mode} ${helper} shadow out of constructor Career creation`, () => {
        const root = mkdtempSync(join(tmpdir(), "game-session-career-constructor-authority-"));
        const intendedRoot = join(root, "intended");
        const divertedRoot = join(root, "diverted");
        const id = `career-constructor-${helper}-${mode}-${crypto.randomUUID()}`;
        const decoy = installCareerHelperDecoy(GameSession.prototype, helper, mode, divertedRoot);
        let session: GameSession | undefined;
        try {
          session = new GameSession(
            id,
            "cosmic-horror",
            CONFIG,
            "investigator",
            "Ada",
            undefined,
            { careerRoot: intendedRoot },
            undefined,
            "preferred",
            runtime("default"),
          );

          expectCanonicalCareerSnapshot(intendedRoot, id, "Ada", session, "p1");
          expect(decoy.calls()).toBe(0);
          if (helper === "careerSessionDirectory") {
            expect(existsSync(join(divertedRoot, id))).toBe(false);
          }
        } finally {
          session?.close();
          decoy.restore();
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  for (const targetKind of ["own", "prototype"] as const) {
    for (const helper of CAREER_HELPERS) {
      for (const mode of ["fake", "throw"] as const) {
        it(`keeps a late-add ${targetKind} ${mode} ${helper} shadow outside canonical Career creation`, () => {
          const root = mkdtempSync(join(tmpdir(), "game-session-career-late-add-authority-"));
          const intendedRoot = join(root, "intended");
          const divertedRoot = join(root, "diverted");
          const id = `career-late-add-${targetKind}-${helper}-${mode}-${crypto.randomUUID()}`;
          const session = new GameSession(
            id,
            "cosmic-horror",
            CONFIG,
            undefined,
            undefined,
            undefined,
            { careerRoot: intendedRoot },
            undefined,
            "preferred",
            runtime("explicit"),
          );
          const target = targetKind === "own" ? session : GameSession.prototype;
          const decoy = installCareerHelperDecoy(target, helper, mode, divertedRoot);
          try {
            expect(session.careerStore).toBeNull();
            expect(existsSync(join(intendedRoot, id))).toBe(false);
            expectDirectDecoyControl(session, helper, mode, decoy);
            const directCalls = decoy.calls();

            const added = session.addPartyMember("Bea", "investigator");
            if ("rejected" in added) throw new Error(added.rejected);
            expect(added.member).toMatchObject({ pcId: "p2", sheet: { name: "Bea", archetypeId: "investigator" } });
            expectCanonicalCareerSnapshot(intendedRoot, id, "Bea", session, "p2");
            expect(decoy.calls()).toBe(directCalls);
            expect(existsSync(join(divertedRoot, id))).toBe(false);
            expect(new CareerFileStore(join(intendedRoot, id)).getSnapshot("Forged")).toBeNull();
          } finally {
            decoy.restore();
            session.close();
            rmSync(root, { recursive: true, force: true });
          }
        });
      }
    }
  }
});
