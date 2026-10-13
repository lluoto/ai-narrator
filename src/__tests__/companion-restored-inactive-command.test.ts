import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { CompanionManager } from "../combat/companion-manager";
import { ORDINARY_COMPANION_FIXTURE, restoreSignedOrdinaryCompanion } from "./helpers/ordinary-companion-fixture";

const CFG = {
  apiKey: "sk-restored-companion-command-test",
  baseUrl: "http://restored-companion-command-test.invalid/v1",
  model: "restored-companion-command-test",
  maxTokens: 64,
  temperature: 0,
};

const COMPANION_ID = "restored-inactive-li";
const COMPANION_NAME = "老李";
const sessions: GameSession[] = [];

afterEach(() => {
  while (sessions.length > 0) sessions.pop()!.close();
});

/**
 * This deliberately uses the ordinary public snapshot/hash/restore boundary.
 * The fixture builds a signed portable CompanionManager + WorldState payload;
 * it never reaches into a GameSession private field to install the companion.
 */
function restoredSession(): GameSession {
  const session = new GameSession(`restored-inactive-${crypto.randomUUID()}`, "cosmic-horror", CFG);
  sessions.push(session);
  restoreSignedOrdinaryCompanion(session, CFG, {
    ...ORDINARY_COMPANION_FIXTURE,
    id: COMPANION_ID,
    name: COMPANION_NAME,
  });
  return session;
}

function companionLifecycle(session: GameSession) {
  const entry = session.exportOrdinarySessionSnapshot().companionManager.companions
    .find((companion) => companion.id === COMPANION_ID);
  if (!entry) throw new Error("restored companion must be present in the public snapshot");
  return {
    active: entry.active,
    invited: entry.invited,
    control: entry.control,
  };
}

function eventText(response: Awaited<ReturnType<GameSession["act"]>>): string {
  return response.events.map((event) => event.content).join("\n");
}

describe("restored inactive companions fail closed", () => {
  test("an active restored companion can leave once; later invite/control/auto/farewell are explicit no-ops", async () => {
    const session = restoredSession();

    const departure = await session.act(`告别 ${COMPANION_NAME}`);
    expect(eventText(departure)).toContain("离开了队伍");
    expect(session.companionManager.isActive(COMPANION_ID)).toBe(false);
    expect(companionLifecycle(session)).toEqual({ active: false, invited: false, control: "auto" });

    for (const command of [
      `邀请 ${COMPANION_NAME}`,
      `接管 ${COMPANION_NAME}`,
      `自动 ${COMPANION_NAME}`,
      `告别 ${COMPANION_NAME}`,
    ]) {
      const before = companionLifecycle(session);
      const response = await session.act(command);
      const text = eventText(response);

      expect(text).toContain("当前不在队伍中");
      expect(text).not.toContain("发出了邀请");
      expect(text).not.toContain("接管了");
      expect(text).not.toContain("恢复自主行动");
      expect(text).not.toContain("离开了队伍");
      expect(companionLifecycle(session)).toEqual(before);
    }
  });

  test("a duplicate active invitation is reported as a no-op instead of another successful invitation", async () => {
    const session = restoredSession();

    const first = await session.act(`邀请 ${COMPANION_NAME}`);
    expect(eventText(first)).toContain("发出了邀请");
    expect(companionLifecycle(session)).toEqual({ active: true, invited: true, control: "auto" });

    const before = companionLifecycle(session);
    const duplicate = await session.act(`邀请 ${COMPANION_NAME}`);
    const text = eventText(duplicate);
    expect(text).toContain("已经收到过邀请");
    expect(text).not.toContain("发出了邀请");
    expect(companionLifecycle(session)).toEqual(before);
  });

  test("a false setControl result never produces a control success event", async () => {
    const session = restoredSession();
    const original = CompanionManager.prototype.setControl;
    CompanionManager.prototype.setControl = () => false;
    try {
      for (const command of [`接管 ${COMPANION_NAME}`, `自动 ${COMPANION_NAME}`]) {
        const before = companionLifecycle(session);
        const response = await session.act(command);
        const text = eventText(response);
        expect(text).toContain("控制权未改变");
        expect(text).not.toContain("接管了");
        expect(text).not.toContain("恢复自主行动");
        expect(companionLifecycle(session)).toEqual(before);
      }
    } finally {
      CompanionManager.prototype.setControl = original;
    }
  });

  test("a null handleDeparture result never produces a departure success event", async () => {
    const session = restoredSession();
    const original = CompanionManager.prototype.handleDeparture;
    CompanionManager.prototype.handleDeparture = () => null;
    try {
      const before = companionLifecycle(session);
      const response = await session.act(`告别 ${COMPANION_NAME}`);
      const text = eventText(response);
      expect(text).toContain("状态未改变");
      expect(text).not.toContain("离开了队伍");
      expect(companionLifecycle(session)).toEqual(before);
    } finally {
      CompanionManager.prototype.handleDeparture = original;
    }
  });
});
