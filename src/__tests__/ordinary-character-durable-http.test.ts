import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { GameSession } from "../api/game-session";
import {
  createOrdinaryArchivedActionReceipt,
  createOrdinarySessionEnvelope,
  OrdinarySessionSnapshotStore,
} from "../api/ordinary-session-snapshot-store";
import { handleRequest, parseOrdinaryCharacterPatchRequest, type SessionRuntimeDependencies } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";

const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const auth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-character-owner" } });

function runtime(): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  return {
    registry,
    dependencies: {
      registry,
      ordinaryIntentPolicy: "development_fallback",
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "opening";
        return session;
      },
    },
  };
}

async function request(root: string, dependencies: SessionRuntimeDependencies, path: string, body?: unknown): Promise<Response> {
  return handleRequest(new Request(`http://test${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
  undefined, undefined, undefined, { mode: "required" }, dependencies);
}

function unreadJsonBody(value: unknown): { body: ReadableStream<Uint8Array>; pulls: () => number } {
  let pulls = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }, { highWaterMark: 0 }),
    pulls: () => pulls,
  };
}

async function create(root: string, dependencies: SessionRuntimeDependencies): Promise<string> {
  const created = await request(root, dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
  expect(created.status).toBe(201);
  return (await created.json() as { sessionId: string }).sessionId;
}

test("ordinary character patch is a durable active-PC receipt and survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-character-durable-"));
  const first = runtime();
  const restarted = runtime();
  try {
    const id = await create(root, first.dependencies);
    const store = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const predecessor = store.read(id);
    expect(predecessor).toMatchObject({ status: "ok", value: { generation: 0 } });
    const predecessorLastActiveAt = predecessor.status === "ok" ? predecessor.value.snapshot.session.lastActiveAt : 0;
    const before = first.registry.get(id)?.getCharacterSummary();
    const hp = (before?.hp as number) - 1;
    const patch = {
      actionId: "ordinary-character-durable-0001", expectedGeneration: 0,
      hp, inventory: ["flashlight", "notebook"], weapons: ["revolver"],
      luck: 42, skills: { stealth: 55 }, attributes: { dexterity: 61 }, creditRating: 31,
    };
    const committed = await request(root, first.dependencies, `/api/sessions/${id}/character`, patch);
    expect(committed.status).toBe(200);
    const receipt = await committed.json() as {
      pcId: string; ordinaryGeneration: number; sessionKind: string; character: Record<string, unknown>;
      inventory: string[]; weapons: string[]; summary: { id: string };
    };
    expect(receipt).toMatchObject({ pcId: "p1", ordinaryGeneration: 1, sessionKind: "ordinary", inventory: patch.inventory, weapons: patch.weapons, summary: { id } });
    expect(receipt.character).toMatchObject({ hp, maxHp: before?.maxHp, luck: 42, creditRating: 31, skillValues: { stealth: 55 }, attributes: { dexterity: 61 } });

    const committedEnvelope = store.read(id);
    expect(committedEnvelope).toMatchObject({ status: "ok", value: { generation: 1, snapshot: { state: { activePlayerId: "p1" } } } });
    if (committedEnvelope.status !== "ok") throw new Error("committed character envelope is required");
    // A re-hashed/forged operation must still be rejected at the envelope
    // boundary, before a malformed scalar or empty own-undefined patch can
    // reach ordinary snapshot persistence.
    for (const patch of [
      { hp: undefined }, { hp: 1_000 }, { luck: 100 }, { hp: 11, maxHp: 10 }, { skills: { bogus: 55 } },
    ]) {
      const forged = structuredClone(committedEnvelope.value) as any;
      forged.idempotency.at(-1).operation.patch = patch;
      delete forged.envelopeHash;
      expect(() => createOrdinarySessionEnvelope(forged)).toThrow();
    }
    const committedLastActiveAt = committedEnvelope.status === "ok" ? committedEnvelope.value.snapshot.session.lastActiveAt : 0;
    expect(committedLastActiveAt).toBeGreaterThan(predecessorLastActiveAt);
    const snapshot = first.registry.get(id)?.exportOrdinarySessionSnapshot();
    const pc = snapshot?.state.characters.find((entry) => entry.pcId === "p1")?.sheet as Record<string, unknown>;
    expect(pc).toMatchObject({ hp, luck: 42, creditRating: 31, skillValues: { stealth: 55 }, attributes: { dexterity: 61 } });
    const playerState = snapshot?.world.tables.player_state.find((entry) => entry.entity_id === "p1");
    expect(playerState).toMatchObject({ inventory: patch.inventory, weapons: patch.weapons });
    expect(snapshot?.world.tables.entities.find((entry) => entry.id === "p1")).toMatchObject({ hp, max_hp: before?.maxHp });

    expect((await request(root, restarted.dependencies, `/api/sessions/${id}`)).status).toBe(200);
    const replay = await request(root, restarted.dependencies, `/api/sessions/${id}/character`, patch);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    expect(await replay.json()).toEqual(receipt);
    const replayedEnvelope = store.read(id);
    expect(replayedEnvelope).toMatchObject({ status: "ok", value: { generation: 1 } });
    expect(replayedEnvelope.status === "ok" ? replayedEnvelope.value.snapshot.session.lastActiveAt : 0).toBe(committedLastActiveAt);
    const restored = restarted.registry.get(id)?.exportOrdinarySessionSnapshot();
    expect(restored?.state.characters.find((entry) => entry.pcId === "p1")?.sheet).toMatchObject({ hp, luck: 42, creditRating: 31 });
    expect(restored?.world.tables.player_state.find((entry) => entry.entity_id === "p1")).toMatchObject({ inventory: patch.inventory, weapons: patch.weapons });
  } finally {
    for (const session of first.registry.values()) session.close();
    for (const session of restarted.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary character patches reject closed/empty contracts, target selectors, stale and conflicting retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-character-contract-"));
  const current = runtime();
  try {
    const id = await create(root, current.dependencies);
    const currentHp = current.registry.get(id)?.getCharacterSummary().hp;
    if (!Number.isSafeInteger(currentHp)) throw new Error("fixture requires an active character HP");
    const validHp = currentHp === 0 ? 1 : 0;
    const conflictingHp = validHp === 0 ? 1 : 0;
    const valid = { actionId: "ordinary-character-contract-0001", expectedGeneration: 0, hp: validHp };
    for (const body of [
      { actionId: valid.actionId, expectedGeneration: 0 },
      { ...valid, pcId: "p2" }, { ...valid, target: "p2" }, { ...valid, extra: true },
      { ...valid, skills: { stealth: "55" } }, { ...valid, skills: { bogus: 55 } }, { ...valid, inventory: [1] },
    ]) {
      const refused = await request(root, current.dependencies, `/api/sessions/${id}/character`, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "ordinary_character_contract_required" });
    }
    // The HTTP parser owns this bound. A malformed dynamic table must not
    // reach snapshot construction and become an ambiguous 500/retry loop.
    const tooManySkills = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`unknown_${index}`, 50]));
    for (const body of [
      { ...valid, skills: tooManySkills },
      { ...valid, skills: { ["x".repeat(129)]: 50 } },
    ]) {
      const refused = await request(root, current.dependencies, `/api/sessions/${id}/character`, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "ordinary_character_contract_required" });
    }
    expect(new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") }).read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
    const oversized = await request(root, current.dependencies, `/api/sessions/${id}/character`, { ...valid, padding: "x".repeat(9 * 1024) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "ordinary_character_contract_required" });
    const committed = await request(root, current.dependencies, `/api/sessions/${id}/character`, valid);
    expect(committed.status).toBe(200);
    const conflict = await request(root, current.dependencies, `/api/sessions/${id}/character`, { ...valid, hp: conflictingHp });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "ordinary_action_id_conflict" });
    const stale = await request(root, current.dependencies, `/api/sessions/${id}/character`, { actionId: "ordinary-character-stale-0001", expectedGeneration: 0, hp: conflictingHp });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "ordinary_generation_conflict", ordinaryGeneration: 1 });
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("character patch parser rejects accessors, prototypes, and symbols without retaining aliases", () => {
  const base = { actionId: "ordinary-character-parser-0001", expectedGeneration: 0, skills: { stealth: 55 } };
  const parsed = parseOrdinaryCharacterPatchRequest(base);
  expect(parsed).not.toBeNull();
  expect(parsed?.operation.patch.skills).toEqual({ stealth: 55 });
  base.skills.stealth = 1;
  expect(parsed?.operation.patch.skills).toEqual({ stealth: 55 });

  const accessor = { actionId: "ordinary-character-parser-0002", expectedGeneration: 0 } as Record<string, unknown>;
  Object.defineProperty(accessor, "hp", { enumerable: true, get: () => 9 });
  expect(parseOrdinaryCharacterPatchRequest(accessor)).toBeNull();
  const inherited = Object.assign(Object.create({ hp: 9 }), { actionId: "ordinary-character-parser-0003", expectedGeneration: 0 }) as Record<string, unknown>;
  expect(parseOrdinaryCharacterPatchRequest(inherited)).toBeNull();
  const symbolic = { actionId: "ordinary-character-parser-0004", expectedGeneration: 0, hp: 9 } as Record<string, unknown>;
  Object.defineProperty(symbolic, Symbol("target"), { enumerable: true, value: "p2" });
  expect(parseOrdinaryCharacterPatchRequest(symbolic)).toBeNull();
  const arraySideChannel = ["notebook"] as string[] & { hidden?: string };
  Object.defineProperty(arraySideChannel, "hidden", { enumerable: false, value: "p2" });
  expect(parseOrdinaryCharacterPatchRequest({ actionId: "ordinary-character-parser-0005", expectedGeneration: 0, inventory: arraySideChannel })).toBeNull();
  const dangerousTable = (key: string) => {
    const table: Record<string, unknown> = {};
    Object.defineProperty(table, key, { enumerable: true, configurable: true, value: 55 });
    return table;
  };
  // These must never be silently assigned through Object.prototype setters and
  // turn into an empty/no-op durable patch.
  for (const [field, key] of [["skills", "__proto__"], ["skills", "constructor"], ["attributes", "prototype"]] as const) {
    expect(parseOrdinaryCharacterPatchRequest({ actionId: "ordinary-character-parser-0006", expectedGeneration: 0, [field]: dangerousTable(key) })).toBeNull();
  }
  expect(parseOrdinaryCharacterPatchRequest({ actionId: "ordinary-character-parser-0007", expectedGeneration: 0, skills: { bogus: 55 } })).toBeNull();
  expect(parseOrdinaryCharacterPatchRequest({ actionId: "ordinary-character-parser-0008", expectedGeneration: 0, skills: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`unknown_${index}`, 50])) })).toBeNull();
  expect(parseOrdinaryCharacterPatchRequest({ actionId: "ordinary-character-parser-0009", expectedGeneration: 0, skills: { ["x".repeat(129)]: 50 } })).toBeNull();
});

test("D&D rejects CoC-only character patch fields before any write", () => {
  const session = new GameSession("ordinary-character-dnd-reject", "dnd5e", CONFIG, "fighter", "Ada");
  try {
    const before = session.getCharacterSummary();
    expect(session.updateActiveCharacter({ luck: 42 })).toMatchObject({ status: "refused", code: "character_ruleset_unsupported" });
    expect(session.getCharacterSummary()).toEqual(before);
  } finally {
    session.close();
  }
});

test("ordinary character patch failure does not pollute its live source", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-character-failure-"));
  const current = runtime();
  let failSuccessor = false;
  current.dependencies.ordinarySnapshots = new OrdinarySessionSnapshotStore({
    root: join(root, "sessions", "ordinary-snapshots"),
    testHooks: { onPublicationStage(stage) { if (failSuccessor && stage === "dirty-persisted") throw new Error("injected character successor failure"); } },
  });
  try {
    const id = await create(root, current.dependencies);
    const before = current.registry.get(id)?.exportOrdinarySessionSnapshot();
    failSuccessor = true;
    const failed = await request(root, current.dependencies, `/api/sessions/${id}/character`, {
      actionId: "ordinary-character-failure-0001", expectedGeneration: 0, hp: 9, inventory: ["forbidden"],
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "ordinary_persistence_indeterminate", ordinaryGeneration: 0 });
    expect(current.dependencies.ordinarySnapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
    expect(current.registry.get(id)?.exportOrdinarySessionSnapshot()).toEqual(before);
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary owner character GET is a detached active-PC durable projection across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-character-read-"));
  const first = runtime();
  const restarted = runtime();
  const foreignAuth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-character-foreign" } });
  try {
    const id = await create(root, first.dependencies);
    const store = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const before = store.read(id);
    expect(before).toMatchObject({ status: "ok", value: { generation: 0 } });

    const initial = await request(root, first.dependencies, `/api/sessions/${id}/character`);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json() as Record<string, any>;
    const initialHp = initialBody.character?.hp;
    expect(typeof initialHp).toBe("number");
    expect(Number.isSafeInteger(initialHp)).toBe(true);
    expect(typeof initialBody.character?.maxHp).toBe("number");
    expect(Array.isArray(initialBody.inventory)).toBe(true);
    expect(Array.isArray(initialBody.weapons)).toBe(true);
    expect(initialBody).toMatchObject({
      sessionKind: "ordinary", ordinaryGeneration: 0, pcId: "p1",
      summary: { id },
      character: { name: "Ada", hp: expect.any(Number), maxHp: expect.any(Number), skills: expect.any(Object), attributes: expect.any(Object) },
      inventory: expect.any(Array), weapons: expect.any(Array),
      sanity: { currentSAN: expect.any(Number), maxSAN: expect.any(Number) },
    });
    expect(store.read(id)).toEqual(before);

    const party = await request(root, first.dependencies, `/api/sessions/${id}/party`, {
      actionId: "ordinary-character-read-p2-0001", expectedGeneration: 0, name: "Bea", archetype: "detective",
    });
    expect(party.status).toBe(201);
    const switched = await request(root, first.dependencies, `/api/sessions/${id}/action`, {
      input: "look around", pcId: "p2", actionId: "ordinary-character-read-p2-0002", expectedGeneration: 1,
    });
    expect(switched.status).toBe(200);
    const beforePatchRead = await request(root, first.dependencies, `/api/sessions/${id}/character`);
    const beforePatchBody = await beforePatchRead.json() as Record<string, any>;
    const patch = {
      actionId: "ordinary-character-read-0001", expectedGeneration: 2,
      hp: beforePatchBody.character.hp - 1, luck: 42, creditRating: 31,
      skills: { stealth: 55 }, attributes: { dexterity: 61 },
      inventory: ["flashlight"], weapons: ["revolver"],
    };
    const committedReadProjection = await request(root, first.dependencies, `/api/sessions/${id}/character`, patch);
    expect(committedReadProjection.status).toBe(200);
    // Party creation and character patches must remain readable receipts after
    // a later active-PC action. This is deliberately a real p2 transition,
    // not a direct GameSession projection: it used to fail while validating
    // the historical party receipt against the successor snapshot.
    const successor = await request(root, first.dependencies, `/api/sessions/${id}/action`, {
      input: "check the p2 sheet after editing", pcId: "p2", actionId: "ordinary-character-read-p2-0003", expectedGeneration: 3,
    });
    expect(successor.status).toBe(200);
    const activeP2 = await request(root, first.dependencies, `/api/sessions/${id}/character`);
    expect(activeP2.status).toBe(200);
    const activeP2Body = await activeP2.json() as Record<string, any>;
    expect(activeP2Body).toMatchObject({
      sessionKind: "ordinary", ordinaryGeneration: 4, pcId: "p2", summary: { playerName: "Bea" },
      character: { name: "Bea", hp: patch.hp, luck: 42, creditRating: 31, skills: { stealth: 55 }, attributes: { dexterity: 61 } },
      inventory: ["flashlight"], weapons: ["revolver"],
    });
    activeP2Body.character.skills.stealth = 1;
    activeP2Body.inventory.push("tamper");
    const reread = await request(root, first.dependencies, `/api/sessions/${id}/character`);
    expect(await reread.json()).toMatchObject({ pcId: "p2", character: { name: "Bea", skills: { stealth: 55 } }, inventory: ["flashlight"] });

    // The authoritative reader must ignore shadowable compatibility methods
    // and sealed projection dispatch must not be redirected to a fake p1.
    const live = first.registry.get(id) as any;
    live.getCharacterSummary = () => ({ name: "forged", hp: 999 });
    expect(Reflect.set(live, "getOrdinaryCharacterEditorProjection", () => ({ pcId: "p1" }))).toBe(false);
    const shadowSafe = await request(root, first.dependencies, `/api/sessions/${id}/character`);
    expect(await shadowSafe.json()).toMatchObject({ pcId: "p2", character: { name: "Bea" } });

    const resumed = await request(root, restarted.dependencies, `/api/sessions/${id}/character`);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ sessionKind: "ordinary", ordinaryGeneration: 4, pcId: "p2", character: { name: "Bea", hp: patch.hp }, inventory: ["flashlight"], weapons: ["revolver"] });

    const unauthorized = await handleRequest(new Request(`http://test/api/sessions/${id}/character`), undefined, undefined,
      { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, foreignAuth,
      undefined, undefined, undefined, { mode: "required" }, first.dependencies);
    expect(unauthorized.status).toBe(404);
    expect(JSON.stringify(await unauthorized.json())).not.toContain("Ada");
  } finally {
    for (const session of first.registry.values()) session.close();
    for (const session of restarted.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("structured receipts retain latest snapshot binding and immutable historical archive binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-structured-receipt-bindings-"));
  const current = runtime();
  try {
    const id = await create(root, current.dependencies);
    const storeRoot = join(root, "sessions", "ordinary-snapshots");
    const store = new OrdinarySessionSnapshotStore({ root: storeRoot });
    const party = await request(root, current.dependencies, `/api/sessions/${id}/party`, {
      actionId: "ordinary-structured-binding-party-0001", expectedGeneration: 0, name: "Bea", archetype: "detective",
    });
    expect(party.status).toBe(201);
    const hot = store.read(id);
    expect(hot.status).toBe("ok");
    if (hot.status !== "ok") throw new Error("current structured receipt is required");

    // A re-hashed latest receipt still has to be the snapshot co-signed by
    // this envelope. `current` must not turn into a general relaxation.
    const hotTamper = structuredClone(hot.value) as any;
    hotTamper.idempotency.at(-1).response.summary.playerName = "forged latest";
    delete hotTamper.envelopeHash;
    expect(() => createOrdinarySessionEnvelope(hotTamper)).toThrow("party response summary does not match its snapshot");

    // This action makes the party receipt historical. Before the current-bit
    // fix it fails here, because it compared generation 1's summary/member to
    // generation 2's active snapshot.
    const later = await request(root, current.dependencies, `/api/sessions/${id}/action`, {
      input: "activate Bea", pcId: "p2", actionId: "ordinary-structured-binding-action-0002", expectedGeneration: 1,
    });
    expect(later.status).toBe(200);
    const successor = store.read(id);
    expect(successor.status).toBe("ok");
    if (successor.status !== "ok") throw new Error("successor structured receipt is required");

    // An archived historic receipt carries its original projection and stays
    // strict even though the hot window no longer compares that old summary
    // to the latest snapshot.
    const archiveName = readdirSync(storeRoot).find((name) => name.endsWith(".ordinary-action-receipt.json")
      && JSON.parse(readFileSync(join(storeRoot, name), "utf8")).record.generation === 1);
    if (!archiveName) throw new Error("historic party archive is required");
    const archived = JSON.parse(readFileSync(join(storeRoot, archiveName), "utf8")) as any;
    const archivedTamper = structuredClone(archived);
    archivedTamper.record.response.summary.playerName = "forged archive";
    delete archivedTamper.archiveHash;
    expect(() => createOrdinaryArchivedActionReceipt(archivedTamper)).toThrow("party response summary does not match its snapshot");

    // Re-hashing an envelope cannot make a divergent historical hot ledger
    // authoritative: the fresh full audit exact-binds it to the archive.
    const ledgerTamper = structuredClone(successor.value) as any;
    ledgerTamper.idempotency[0].response.summary.playerName = "forged ledger";
    delete ledgerTamper.envelopeHash;
    const forged = createOrdinarySessionEnvelope(ledgerTamper);
    const body = `${JSON.stringify(forged)}\n`;
    writeFileSync(join(storeRoot, `${id}.${forged.envelopeHash}.ordinary-envelope.json`), body);
    writeFileSync(join(storeRoot, `${id}.ordinary-current.json`), JSON.stringify({
      schemaVersion: forged.schemaVersion, sessionId: id, envelopeHash: forged.envelopeHash,
      generation: forged.generation, bodyBytes: new TextEncoder().encode(body).byteLength,
    }) + "\n");
    expect(new OrdinarySessionSnapshotStore({ root: storeRoot }).audit(id)).toMatchObject({
      status: "refused", code: "ORDINARY_SNAPSHOT_CORRUPT",
    });
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("character route shape and compiled/other ordinary mutation gates stay ahead of body reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-character-route-shape-"));
  const current = runtime();
  try {
    const id = await create(root, current.dependencies);
    const extraBody = unreadJsonBody({ actionId: "ordinary-character-extra-0001", expectedGeneration: 0, hp: 9 });
    const extra = await handleRequest(new Request(`http://test/api/sessions/${id}/character/extra`, { method: "POST", headers: { "Content-Type": "application/json" }, body: extraBody.body }),
      undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, current.dependencies);
    expect(extra.status).toBe(404);
    expect(extraBody.pulls()).toBe(0);
    for (const route of ["kp", "npc-chat"]) {
      const lockedBody = unreadJsonBody({ anything: "must not be read" });
      const locked = await handleRequest(new Request(`http://test/api/sessions/${id}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: lockedBody.body }),
        undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, current.dependencies);
      expect(locked.status).toBe(409);
      expect(lockedBody.pulls()).toBe(0);
    }

    // A real compiled identity is required here: a caller-controlled object
    // must not be able to opt into the compiled gate merely by claiming one.
    const fixture = await compiledModuleHttpFixture("ordinary-character-compiled-gate");
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    const compiledSnapshots = new CompiledSessionSnapshotStore({ root: join(root, "sessions", "compiled-snapshots") });
    const compiledRegistry = new Map<string, GameSession>();
    const compiledCreated = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, compiledSnapshots, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
    undefined, undefined, undefined, { mode: "required" }, { registry: compiledRegistry });
    expect(compiledCreated.status).toBe(201);
    const compiledId = (await compiledCreated.json() as { sessionId: string }).sessionId;
    const compiledBody = unreadJsonBody({ actionId: "ordinary-character-compiled-0001", expectedGeneration: 0, hp: 9 });
    const compiled = await handleRequest(new Request(`http://test/api/sessions/${compiledId}/character`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: compiledBody.body,
    }), catalog, compiledSnapshots, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth,
    undefined, undefined, undefined, { mode: "required" }, { registry: compiledRegistry });
    expect(compiled.status).toBe(409);
    expect(await compiled.json()).toMatchObject({ code: "compiled_mutation_unsupported" });
    expect(compiledBody.pulls()).toBe(0);
    for (const session of compiledRegistry.values()) session.close();
  } finally {
    for (const session of current.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
