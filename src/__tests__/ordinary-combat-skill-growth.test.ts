import { afterEach, expect, test } from "bun:test";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash, type OrdinarySnapshotJson } from "../api/ordinary-game-session-snapshot";
import { newStatus } from "../rules/status-effects";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const realRandom = Math.random;
const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;

afterEach(() => { Math.random = realRandom; });

const FIXTURE_HOSTILES = [
  "low-fighting-target", "high-fighting-target", "penalized-target",
  "unverified-weapon-target", "unverified-verb-target", "bottle-target",
  "fallback-target", "luck-target", "dnd-target",
];

function blank(id: string, ruleset: "cosmic-horror" | "dnd5e" = "cosmic-horror"): GameSession {
  return new GameSession(
    id, ruleset, undefined, undefined, undefined,
    undefined, undefined, undefined, "development_fallback",
  );
}

function durableBlank(id: string): GameSession {
  const session = new GameSession(
    id, "cosmic-horror", undefined, undefined, undefined,
    undefined, undefined, undefined, "development_fallback",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  );
  Object.defineProperty(session, "act", {
    configurable: true,
    value: (input: string, pcId?: string) => durableAct(session, input, pcId),
  });
  return session;
}

async function durableAct(session: GameSession, input: string, pcId?: string) {
  return runOrdinaryDurableActionTransaction(
    session,
    durableCareerHostCapability,
    async (act) => act(input, pcId),
  );
}

function fresh(
  id: string,
  ruleset: "cosmic-horror" | "dnd5e" = "cosmic-horror",
  withCharacter = true,
  playerStatus: string[] = [],
  withFixtureHostiles = true,
): GameSession {
  const source = new GameSession(
    id, ruleset, undefined,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined, undefined, undefined, "development_fallback",
  );
  // Ordinary portable snapshots are intentionally CoC-only. D&D coverage
  // below uses the real installed module path instead of inventing a second
  // snapshot format merely for fixture setup.
  if (ruleset !== "cosmic-horror") return source;
  const target = blank(id, ruleset);
  try {
    restoreSignedOrdinaryWorld(target, {
      apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 64, temperature: 0,
    }, (world) => {
      const scene = world.getCurrentState().scene;
      for (const hostileId of withFixtureHostiles ? FIXTURE_HOSTILES : []) {
        world.upsertEntity({
          id: hostileId, name: hostileId, type: "monster", hp: 20, maxHp: 20, ac: 0,
          status: [], position: scene, scene_id: scene,
        });
      }
      const player = world.getEntity("p1");
      if (player && playerStatus.length) world.upsertEntity({ ...player, status: [...playerStatus] });
    }, source);
  } finally {
    source.close();
  }
  return target;
}

/** Seed persistent p1 skills before the module/action path needs character-map aliases. */
function freshWithSkills(id: string, skillValues: Record<string, number>, withFixtureHostiles = true): GameSession {
  const source = fresh(id, "cosmic-horror", true, [], withFixtureHostiles);
  const snapshot = source.exportOrdinarySessionSnapshot();
  const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
  if (!p1 || p1.sheet === null || Array.isArray(p1.sheet) || typeof p1.sheet !== "object") throw new Error("fixture requires p1 sheet");
  const sheet = p1.sheet as Record<string, OrdinarySnapshotJson>;
  if (sheet.skillValues === null || Array.isArray(sheet.skillValues) || typeof sheet.skillValues !== "object") throw new Error("fixture requires p1 skillValues");
  Object.assign(sheet.skillValues as Record<string, OrdinarySnapshotJson>, skillValues);
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const target = blank(id);
  target.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return target;
}

function addHostile(session: GameSession, id: string, hp = 20): void {
  expect(session.world.getEntity(id)).toMatchObject({ id, type: "monster", hp, maxHp: hp });
}

function fighting(session: GameSession, value: number): void {
  expect(session.updateCharacter(session.activePlayerId, { skillValues: { fighting: value } }))
    .toMatchObject({ status: "updated" });
}

test("ordinary CoC handleAttack uses the acting sheet's unarmed fighting score and marks only a real success", async () => {
  const session = freshWithSkills("ordinary-combat-growth-handle-attack", { fighting: 1, dodge: 90 });
  try {
    fighting(session, 1);
    addHostile(session, "low-fighting-target");
    Math.random = () => 0.1; // d100=11: must fail at fighting=1.

    const messages: string[] = [];
    expect(await (session as any).handleAttack({ action: "attack", target: "low-fighting-target" }, (line: string) => messages.push(line), "攻击 low-fighting-target")).toBe(true);
    expect(messages.join("\n")).toContain("目标=1%");
    expect(session.world.getEntity("low-fighting-target")?.hp).toBe(20);
    // One handleAttack round includes the NPC counterattack. The player's
    // unarmed attack failed, so it cannot grow fighting; its separately
    // resolved dodge may grow instead.
    expect(session.skillGrowthMarks).not.toContain("fighting");
    expect(session.skillGrowthMarks).toContain("dodge");

    fighting(session, 90);
    addHostile(session, "high-fighting-target");
    const highMessages: string[] = [];
    expect(await (session as any).handleAttack({ action: "attack", target: "high-fighting-target" }, (line: string) => highMessages.push(line), "攻击 high-fighting-target")).toBe(true);
    expect(highMessages.join("\n")).toContain("目标=90%");
    // The player attack and the following NPC counterattack are distinct
    // successful CoC uses; each has exactly one owner-scoped growth mark.
    expect([...session.skillGrowthMarks].sort()).toEqual(["dodge", "fighting"]);

    // A second successful round still leaves exactly one mark for each skill.
    expect(await (session as any).handleAttack({ action: "attack", target: "high-fighting-target" }, () => 0, "攻击 high-fighting-target")).toBe(true);
    expect([...session.skillGrowthMarks].sort()).toEqual(["dodge", "fighting"]);
  } finally {
    session.close();
  }
});

test("a successful ordinary unarmed attack mark survives snapshot restore and rest, then settles through module advancement", async () => {
  const realRandom = Math.random;
  const source = freshWithSkills("ordinary-combat-growth-snapshot-rest", { fighting: 1, dodge: 0 }, false);
  const restored = durableBlank("ordinary-combat-growth-snapshot-rest");
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect((await source.act("前往维修间")).error).toBeUndefined();
    // The installed package supplies Mi-Go in this scene. A zero dodge target
    // can still critically succeed on a natural 1, so drive the complete
    // exchange with explicit entropy: player attack succeeds; the Mi-Go
    // counterattack succeeds; the player's dodge rolls an actual failure.
    Math.random = (() => {
      const values = [0, 0, 0, 0.5, 0];
      let index = 0;
      return () => values[index++] ?? 0;
    })();
    expect((await source.act("攻击 Mi-Go")).error).toBeUndefined();
    expect(source.skillGrowthMarks).toEqual(["fighting"]);
    const snapshot: any = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));
    expect(snapshot.state.skillGrowthMarksByPC).toEqual([{ pcId: "p1", skills: ["fighting"] }]);

    restored.restoreOrdinarySessionSnapshot(snapshot);
    expect(restored.skillGrowthMarks).toEqual(["fighting"]);
    let restRolls = 0;
    Math.random = () => {
      restRolls += 1;
      throw new Error("rest must not settle restored skill marks");
    };
    expect((await restored.act("休息")).error).toBeUndefined();
    expect(restRolls).toBe(0);
    expect(restored.activeCharacter?.skillValues.fighting).toBe(1);
    expect(restored.skillGrowthMarks).toEqual(["fighting"]);

    let settlementRandomCalls = 0;
    Math.random = (() => {
      const values = [0.5, 0]; let index = 0;
      return () => {
        settlementRandomCalls += 1;
        return values[index++] ?? 0;
      };
    })();
    const requested = await restored.act("模组结算");
    expect(requested.error).toBeUndefined();
    expect(requested.narrative).toContain("确认离开");
    expect(settlementRandomCalls).toBe(0);
    expect(restored.dead).toBe(false);
    expect(restored.activeCharacter?.skillValues.fighting).toBe(1);
    expect(restored.skillGrowthMarks).toEqual(["fighting"]);

    expect((await restored.act("确定")).error).toBeUndefined();
    expect(restored.activeCharacter?.skillValues.fighting).toBe(2);
    expect(restored.skillGrowthMarks).toEqual([]);
    expect(restored.dead).toBe(false);
    expect(restored.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(settlementRandomCalls).toBe(2);
  } finally {
    Math.random = realRandom;
    source.close();
    restored.close();
  }
});

test("ordinary unarmed CoC attacks retain the active status penalty, while unverified weapon text cannot borrow fighting", async () => {
  let session = fresh("ordinary-combat-growth-penalty-and-weapon", "cosmic-horror", true, [newStatus("head_dazed", 2)]);
  try {
    fighting(session, 90);
    addHostile(session, "penalized-target");
    Math.random = () => 0.7; // d100=71: fails only if the -20 penalty is applied.
    const messages: string[] = [];
    expect(await (session as any).handleAttack({ action: "attack", target: "penalized-target" }, (line: string) => messages.push(line), "攻击 penalized-target")).toBe(true);
    expect(messages.join("\n")).toContain("目标=70%");
    expect(session.world.getEntity("penalized-target")?.hp).toBe(20);
    expect(session.skillGrowthMarks).toEqual([]);

    session.close();
    Math.random = realRandom;
    session = fresh("ordinary-combat-growth-penalty-and-weapon-clean");
    fighting(session, 90);
    addHostile(session, "unverified-weapon-target");
    Math.random = () => 0;
    expect(await (session as any).handleAttack({ action: "attack", target: "unverified-weapon-target", weapon: ".38左轮" }, (line: string) => messages.push(line))).toBe(true);
    expect(messages.join("\n")).toContain("目标=50%");
    expect(session.world.getEntity("unverified-weapon-target")?.hp).toBeLessThan(20);
    expect(session.skillGrowthMarks).toEqual(["dodge"]);

    addHostile(session, "unverified-verb-target");
    Math.random = () => 0;
    expect(await (session as any).handleAttack({ action: "attack", target: "unverified-verb-target" }, (line: string) => messages.push(line), "对 unverified-verb-target 使用铁锹")).toBe(true);
    expect(messages.join("\n")).toContain("目标=50%");
    expect(session.world.getEntity("unverified-verb-target")?.hp).toBeLessThan(20);
    expect(session.skillGrowthMarks).toEqual(["dodge"]);

    addHostile(session, "bottle-target");
    Math.random = () => 0;
    expect(await (session as any).handleAttack({ action: "attack", target: "bottle-target" }, (line: string) => messages.push(line), "对 bottle-target 使用瓶子")).toBe(true);
    expect(messages.join("\n")).toContain("目标=50%");
    expect(session.world.getEntity("bottle-target")?.hp).toBeLessThan(20);
    expect(session.skillGrowthMarks).toEqual(["dodge"]);
  } finally {
    session.close();
  }
});

test("ordinary CoC act() combat fallback uses fighting and records the active PC owner only", async () => {
  const session = fresh("ordinary-combat-growth-act-fallback");
  try {
    const p2 = session.addPartyMember("Bea", "investigator");
    if ("rejected" in p2) throw new Error(p2.rejected);
    fighting(session, 1);
    addHostile(session, "fallback-target");
    // The real fallback is reached only when no handler claims the parsed
    // intent. This preserves act()'s turn/tick ownership while exercising the
    // duplicate combat implementation rather than calling it directly.
    const originalHandleIntent = (session as any).handleIntent;
    (session as any).handleIntent = async () => false;
    Math.random = () => 0.1;
    try {
      const response = await session.act("攻击", "p1");
      expect(response.events.map((event) => event.content).join("\n")).toContain("目标=1");
    } finally {
      (session as any).handleIntent = originalHandleIntent;
    }
    expect(session.world.getEntity("fallback-target")?.hp).toBe(20);
    expect(session.skillGrowthMarks).toEqual([]);

    (session as any).handleIntent = async () => false;
    try {
      const response = await session.act("向敌人攻击", "p1");
      expect(response.events.map((event) => event.content).join("\n")).toContain("目标=1");
    } finally {
      (session as any).handleIntent = originalHandleIntent;
    }
    expect(session.world.getEntity("fallback-target")?.hp).toBe(20);
    expect(session.skillGrowthMarks).toEqual([]);

    // Both marks below require successful p2 rolls; Bea's generated dodge is
    // otherwise unrelated entropy from party-member construction.
    expect(session.updateCharacter(p2.member.pcId, { skillValues: { fighting: 90, dodge: 90 } }))
      .toMatchObject({ status: "updated" });
    Math.random = () => 0.1;
    expect(await session.act("攻击", "p2")).toBeDefined();
    expect(session.activePlayerId).toBe("p2");
    // This normal handleAttack round includes both the successful fighting
    // attack and a separately resolved successful dodge against the counter.
    expect([...session.skillGrowthMarks].sort()).toEqual(["dodge", "fighting"]);
    await session.act("状态", "p1");
    expect(session.skillGrowthMarks).toEqual([]);
  } finally {
    session.close();
  }
});

test("ordinary attacks without a target, with unaffordable luck, or under D&D do not create a CoC growth mark", async () => {
  const ordinary = fresh("ordinary-combat-growth-no-execution", "cosmic-horror", true, [], false);
  const dnd = fresh("ordinary-combat-growth-dnd", "dnd5e");
  try {
    fighting(ordinary, 90);
    Math.random = () => 0;
    expect(await (ordinary as any).handleAttack({ action: "attack" }, () => 0, "攻击")).toBe(true);
    expect(ordinary.skillGrowthMarks).toEqual([]);

    expect((await ordinary.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect(activateRegisteredGameSessionSceneForTest(ordinary, "维修间")).toBe(true);
    expect(ordinary.updateActiveCharacter({ luck: 0 })).toMatchObject({ status: "updated" });
    expect(await (ordinary as any).handleAttack({ action: "attack", target: "mi-go", luckSpend: 1 }, () => 0, "攻击 Mi-Go")).toBe(true);
    expect(ordinary.skillGrowthMarks).toEqual([]);

    expect((await dnd.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect(activateRegisteredGameSessionSceneForTest(dnd, "维修间")).toBe(true);
    Math.random = () => 0;
    expect(await (dnd as any).handleAttack({ action: "attack", target: "mi-go" }, () => 0)).toBe(true);
    expect(dnd.skillGrowthMarks).toEqual([]);
  } finally {
    ordinary.close();
    dnd.close();
  }
});
