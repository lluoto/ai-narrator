import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";
import { CareerFileStore } from "../character/career-file";

const CLOSED_SESSION_ERROR = "closed GameSession cannot accept actions";
const CLOSED_READ_ERROR = "closed GameSession cannot read session state";

function capture(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectClosed(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(CLOSED_SESSION_ERROR);
}

it("does not append direct messages after repeated close", () => {
  const session = new GameSession(`closed-direct-history-${crypto.randomUUID()}`, "cosmic-horror");
  try {
    session.close();
    expect(() => session.close()).not.toThrow();

    const error = capture(() => session.sendMessage("KP", "must not enter closed history"));

    expectClosed(error);
    expect(() => session.getHistory()).toThrow(CLOSED_READ_ERROR);
  } finally {
    session.close();
  }
});

it("does not change a character or its real Career root after close", () => {
  const careerRoot = mkdtempSync(join(tmpdir(), "closed-direct-career-"));
  const id = `closed-direct-career-${crypto.randomUUID()}`;
  const session = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined, { careerRoot });
  try {
    const luckBefore = session.activeCharacter.luck;
    const careers = new CareerFileStore(join(careerRoot, id));
    const careerBefore = careers.exportPortableProjection();
    expect(luckBefore).toBeGreaterThan(0);

    session.close();
    expect(() => session.close()).not.toThrow();
    const luckError = capture(() => session.spendCharacterLuck("p1", 1));
    const careerError = capture(() => session.addPartyMember("Bea", "detective"));

    // The old direct path spent Luck even after close; a real Career root also
    // proves that a closed public creation path cannot create a new file.
    expect(careers.exportPortableProjection()).toEqual(careerBefore);
    expectClosed(luckError);
    expectClosed(careerError);
    expect(() => session.activeCharacter).toThrow(CLOSED_READ_ERROR);
  } finally {
    session.close();
    rmSync(careerRoot, { recursive: true, force: true });
  }
});

it("rejects closed SAN writes at the lifecycle boundary before touching SAN state", () => {
  const session = new GameSession(
    `closed-direct-san-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "detective",
    "Ada",
  );
  try {
    const sanityBefore = session.sanity.state;
    session.close();
    expect(() => session.close()).not.toThrow();
    const error = capture(() => session.setPlayerSan("p1", Math.max(0, sanityBefore.currentSAN - 1)));

    expectClosed(error);
    expect(() => session.sanity.state).toThrow(CLOSED_READ_ERROR);
  } finally {
    session.close();
  }
});

it("seals a retained party-member SAN facade after close", () => {
  const careerRoot = mkdtempSync(join(tmpdir(), "closed-direct-party-san-"));
  const session = new GameSession(
    `closed-direct-party-san-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "detective",
    "Ada",
    undefined,
    { careerRoot },
  );
  try {
    const added = session.addPartyMember("Bea", "detective");
    if ("rejected" in added) throw new Error(`unexpected party-member rejection: ${added.rejected}`);
    const retainedMember = added.member;

    expect(retainedMember.san.state.currentSAN).toBeGreaterThan(0);

    session.close();

    expect(() => retainedMember.san.state).toThrow(CLOSED_READ_ERROR);
  } finally {
    session.close();
    rmSync(careerRoot, { recursive: true, force: true });
  }
});
