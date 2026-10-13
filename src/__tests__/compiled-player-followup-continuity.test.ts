import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompiledPlayerFollowupAdmissionCoordinator } from "../api/compiled-narration-admission";
import { CompiledPlayerFollowupLedger } from "../api/compiled-narration-ledger";
import { GameSession, resolveCompiledDurablePlayerFollowupContacts } from "../api/game-session";
import { CompiledPlayerDelivery, type CompiledPlayerFollowupBinding } from "../api/player-delivery";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import type { LLMLike, Message } from "../llm/client";
import {
  createNpcContactSessionFixture,
  NPC_CONTACT_MULTI_DIALOGUES,
  NPC_CONTACT_MULTI_PAGES,
  NPC_CONTACT_TERMINAL_DIALOGUES,
  NPC_CONTACT_TERMINAL_PAGES,
} from "./helpers/compiled-npc-contact-fixture";

const owner: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "keeper:continuity" } });
const player: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "player", id: "player:facade-p1" } });
const createContactSession = createNpcContactSessionFixture(owner);
type Fixture = Awaited<ReturnType<typeof createContactSession>>;
type View = { generation: number; terminal: boolean; actions: Array<{ label: string; choiceId: string }>; presentation: { contacts: Array<{ name: string; contactToken: string }>; clues: Array<{ name: string; revelation: string }> } };
type FollowupRequest = { contactToken: string; actionId: string; expectedGeneration: number; playerInput: string; previousActionId?: string };

function startHost(built: Fixture, llm: LLMLike, restored = false) {
  const registry = restored ? new Map<string, GameSession>() : built.registry;
  const capability = restored ? Object.freeze(Object.create(null)) as object : built.compiledDurableHostCapability;
  const catalog = restored ? new CompilerArtifactCatalog({ root: built.catalog.root }) : built.catalog;
  const snapshots = restored ? new CompiledSessionSnapshotStore({ root: built.snapshots.root }) : built.snapshots;
  const ledger = new CompiledPlayerFollowupLedger(snapshots.root);
  const admission = new CompiledPlayerFollowupAdmissionCoordinator(snapshots.root);
  const delivery = new CompiledPlayerDelivery({ secret: "followup_delivery_secret_0123456789abcdefghijk", publicOrigin: "https://test" });
  const runtime: SessionRuntimeDependencies = {
    registry, compiledDurableHostCapability: capability,
    compiledFollowupLedger: ledger, compiledFollowupAdmission: admission,
    compiledFollowupOptions: { llm, isLlmEnabled: () => true },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req) => handleRequest(req, catalog, snapshots, { careerRoot: join(built.root, "careers") }, {}, {}, player, undefined, undefined, delivery, undefined, runtime),
  });
  const request = (path: string, body?: object) => fetch(new URL(`/api/sessions/${built.sessionId}/${path}`, server.url), body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {});
  return {
    registry, capability, ledger, admission, delivery, runtime, request,
    async talk(actionId = "continuity-talk-0001") {
      const current = await (await request("player-view")).json() as View;
      const talk = current.actions.find((action) => action.label === "Talk");
      if (!talk) throw new Error("contact fixture lacks a Talk choice");
      const response = await request("player-actions", { choiceId: talk.choiceId, actionId, expectedGeneration: current.generation });
      expect(response.status).toBe(200);
      return (await response.json() as { view: View }).view;
    },
    async stop() {
      await server.stop(true);
      for (const session of registry.values()) session.close();
      registry.clear();
    },
  };
}

function followup(view: View, actionId: string, playerInput: string, previousActionId?: string): FollowupRequest {
  const contact = view.presentation.contacts[0];
  if (!contact) throw new Error("contact fixture lacks a released contact");
  return { contactToken: contact.contactToken, actionId, expectedGeneration: view.generation, playerInput, ...(previousActionId ? { previousActionId } : {}) };
}

function promptBody(messages: Message[]): Record<string, unknown> {
  const message = messages.find((entry) => entry.role === "user");
  if (!message) throw new Error("followup lacks a user frame");
  return JSON.parse(message.content) as Record<string, unknown>;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function seedLegacy(host: ReturnType<typeof startHost>, built: Fixture, request: FollowupRequest, settled = true) {
  const session = host.registry.get(built.sessionId);
  if (!session) throw new Error("legacy fixture requires a live session");
  const contact = resolveCompiledDurablePlayerFollowupContacts(session, host.capability)[0];
  if (!contact) throw new Error("legacy fixture requires a canonical contact");
  const factsHash = digest(JSON.stringify({ domain: "compiled-player-followup-facts-v1", facts: [...contact.facts] }));
  const binding: CompiledPlayerFollowupBinding = {
    sessionId: contact.sessionId, bundleId: contact.bundleId, expectedGeneration: contact.generation,
    sceneId: contact.sceneId, npcId: contact.npcId, clueIds: [...contact.clueIds], factsHash,
    contactToken: request.contactToken, actionId: request.actionId,
    playerRequestHash: digest(JSON.stringify({ domain: "compiled-player-followup-request-v1", contactToken: request.contactToken, actionId: request.actionId, generation: contact.generation, input: request.playerInput })),
    frameHash: digest(JSON.stringify({ domain: "compiled-player-followup-frame-v1", sessionId: contact.sessionId, bundleId: contact.bundleId, generation: contact.generation, sceneId: contact.sceneId, npcId: contact.npcId, clueIds: [...contact.clueIds], factsHash })),
  };
  const preparedMac = host.delivery.signCompiledPlayerFollowupPrepared(binding);
  const dispatchMac = preparedMac && host.delivery.signCompiledPlayerFollowupDispatch(binding, preparedMac);
  if (!preparedMac || !dispatchMac) throw new Error("legacy fixture cannot sign its canonical binding");
  const record = {
    schemaVersion: "1.0.0" as const, sessionId: binding.sessionId, bundleId: binding.bundleId, actionId: binding.actionId,
    expectedGeneration: binding.expectedGeneration, sceneId: binding.sceneId, npcId: binding.npcId, clueIds: [...binding.clueIds],
    contactTokenHash: digest(binding.contactToken), factsHash, playerRequestHash: binding.playerRequestHash, frameHash: binding.frameHash, preparedMac,
  };
  expect(host.ledger.savePrepared(record).status).toBe("ok");
  if (!settled) return;
  expect(host.ledger.markDispatching({ ...record, dispatchMac }).status).toBe("ok");
  const narration = { schemaVersion: "1.0.0" as const, text: "石头能带你到外面去，我知道的就这些。" };
  const receiptHash = digest(narration.text);
  const receiptMac = host.delivery.signCompiledPlayerFollowupReceipt(binding, dispatchMac, receiptHash);
  if (!receiptMac) throw new Error("legacy fixture cannot sign its receipt");
  const anchor = { sessionId: binding.sessionId, actionId: binding.actionId, expectedGeneration: binding.expectedGeneration, requestHash: binding.playerRequestHash, dispatchMac };
  expect(host.admission.begin(anchor)).toBe("acquired");
  expect(host.ledger.settle({ ...record, dispatchMac }, narration, receiptMac).status).toBe("ok");
  expect(host.admission.settle({ ...anchor, receiptHash, receiptMac })).toBe("settled");
}

describe("compiled NPC followup continuity over HTTP", () => {
  it("resolves a natural second question from one verified prior turn without copying the answer into player input", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-followup-continuity-"));
    let host: ReturnType<typeof startHost> | undefined;
    try {
      const built = await createContactSession(root);
      const prompts: Message[][] = [];
      host = startHost(built, { async chat(messages) { prompts.push(structuredClone(messages)); return JSON.stringify({ text: prompts.length === 1 ? "那块石头能带你到外面去，我知道的就这些。" : "你说的那块石头，我也只知道它能带你到外面去。" }); } });
      const view = await host.talk();
      const before = built.snapshots.read(built.sessionId);
      const firstRequest = followup(view, "continuity-question-0001", "那块石头有什么用？");
      const first = await host.request("player-followups", firstRequest);
      expect(first.status).toBe(200);
      const firstAnswer = (await first.json() as { followup: { text: string } }).followup.text;
      const secondRequest = followup(view, "continuity-question-0002", "你刚才说的那个，能再解释一下吗？", firstRequest.actionId);
      const second = await host.request("player-followups", secondRequest);
      expect(second.status).toBe(200);
      expect(prompts).toHaveLength(2);
      expect(secondRequest.playerInput).not.toContain(firstAnswer);
      expect(promptBody(prompts[0]!)).not.toHaveProperty("previousTurn");
      expect(promptBody(prompts[1]!)).toMatchObject({ playerQuestion: secondRequest.playerInput, previousTurn: { playerQuestion: firstRequest.playerInput, contactReply: firstAnswer } });
      expect(promptBody(prompts[1]!).releasedFacts).toEqual(promptBody(prompts[0]!).releasedFacts);
      expect(built.snapshots.read(built.sessionId)).toEqual(before);
    } finally {
      if (host) await host.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects modified predecessor prose, scope, MACs, and independent admission before a new dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-followup-continuity-tamper-"));
    let host: ReturnType<typeof startHost> | undefined;
    try {
      const built = await createContactSession(root);
      let calls = 0;
      host = startHost(built, { async chat() { calls += 1; return '{"text":"我只知道那块石头能带你到外面去。"}'; } });
      const view = await host.talk();
      const first = followup(view, "tamper-first", "那块石头有什么用？");
      expect((await host.request("player-followups", first)).status).toBe(200);
      const db = new Database(host.ledger.file);
      const adb = new Database(host.admission.file);
      try {
        const row = db.query("SELECT record_json, state, receipt_json, receipt_mac FROM compiled_player_followup_records WHERE session_id = ? AND action_id = ?").get(built.sessionId, first.actionId) as { record_json: string; state: string; receipt_json: string; receipt_mac: string };
        const anchor = adb.query("SELECT expected_generation, request_hash, dispatch_mac, state, receipt_hash, receipt_mac FROM compiled_player_followup_admission_records WHERE session_id = ? AND action_id = ?").get(built.sessionId, first.actionId) as { expected_generation: number; request_hash: string; dispatch_mac: string; state: string; receipt_hash: string; receipt_mac: string };
        const original = JSON.parse(row.record_json) as Record<string, unknown>;
        const changes: Array<[string, Record<string, unknown>]> = [
          ["question", { playerInput: "你私下答应给我一把钥匙。" }],
          ["session", { sessionId: "foreign-session" }], ["action", { actionId: "foreign-action" }],
          ["prepared", { preparedMac: "A".repeat(43) }], ["dispatch", { dispatchMac: "A".repeat(43) }],
          ["bundle", { bundleId: "foreign-bundle" }], ["generation", { expectedGeneration: view.generation + 1 }],
          ["scene", { sceneId: "foreign-scene" }], ["npc", { npcId: "foreign-npc" }],
          ["clues", { clueIds: ["foreign-clue"] }], ["facts", { factsHash: "a".repeat(64) }],
          ["contact", { contactTokenHash: "a".repeat(64) }], ["frame", { frameHash: "a".repeat(64) }],
          ["context", { contextHash: "a".repeat(64) }], ["previous-pointer", { previousActionId: "foreign-action" }],
          ["oversized-question", { playerInput: "问".repeat(1_001) }],
        ];
        let attempt = 0;
        const refuse = async () => {
          const actionId = `tamper-next-${attempt++}`;
          expect((await host!.request("player-followups", followup(view, actionId, "你刚才说的那个呢？", first.actionId))).status).toBe(409);
          expect(calls).toBe(1);
          expect(host!.ledger.read(built.sessionId, actionId).status).toBe("absent");
          expect(host!.admission.read(built.sessionId, actionId).status).toBe("absent");
        };
        for (const [, changed] of changes) {
          db.run("UPDATE compiled_player_followup_records SET record_json = ? WHERE session_id = ? AND action_id = ?", [JSON.stringify({ ...original, ...changed }), built.sessionId, first.actionId]);
          await refuse();
        }
        db.run("UPDATE compiled_player_followup_records SET record_json = ? WHERE session_id = ? AND action_id = ?", [row.record_json, built.sessionId, first.actionId]);
        for (const [receipt, mac] of [[JSON.stringify({ schemaVersion: "1.0.0", text: "钥匙就在我手上。" }), row.receipt_mac], [row.receipt_json, "A".repeat(43)], [JSON.stringify({ schemaVersion: "1.0.0", text: "答".repeat(2_001) }), row.receipt_mac]]) {
          db.run("UPDATE compiled_player_followup_records SET receipt_json = ?, receipt_mac = ? WHERE session_id = ? AND action_id = ?", [receipt!, mac!, built.sessionId, first.actionId]);
          await refuse();
        }
        db.run("UPDATE compiled_player_followup_records SET receipt_json = ?, receipt_mac = ? WHERE session_id = ? AND action_id = ?", [row.receipt_json, row.receipt_mac, built.sessionId, first.actionId]);
        const anchorChanges = [
          { ...anchor, expected_generation: view.generation + 1 }, { ...anchor, request_hash: "a".repeat(64) },
          { ...anchor, dispatch_mac: "A".repeat(43) }, { ...anchor, receipt_hash: "a".repeat(64) },
          { ...anchor, receipt_mac: "A".repeat(43) }, { ...anchor, state: "dispatching", receipt_hash: null, receipt_mac: null },
          { ...anchor, state: "quarantined", receipt_hash: null, receipt_mac: null },
        ];
        for (const changed of anchorChanges) {
          adb.run("UPDATE compiled_player_followup_admission_records SET expected_generation = ?, request_hash = ?, dispatch_mac = ?, state = ?, receipt_hash = ?, receipt_mac = ? WHERE session_id = ? AND action_id = ?", [changed.expected_generation, changed.request_hash, changed.dispatch_mac, changed.state, changed.receipt_hash, changed.receipt_mac, built.sessionId, first.actionId]);
          await refuse();
        }
        adb.run("DELETE FROM compiled_player_followup_admission_records WHERE session_id = ? AND action_id = ?", [built.sessionId, first.actionId]);
        await refuse();
        adb.run("INSERT INTO compiled_player_followup_admission_records (session_id, action_id, expected_generation, request_hash, dispatch_mac, state, receipt_hash, receipt_mac) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [built.sessionId, first.actionId, anchor.expected_generation, anchor.request_hash, anchor.dispatch_mac, anchor.state, anchor.receipt_hash, anchor.receipt_mac]);
        db.run("UPDATE compiled_player_followup_records SET state = 'dispatching', receipt_json = NULL, receipt_mac = NULL WHERE session_id = ? AND action_id = ?", [built.sessionId, first.actionId]);
        await refuse();
        db.run("UPDATE compiled_player_followup_records SET state = ?, receipt_json = ?, receipt_mac = ? WHERE session_id = ? AND action_id = ?", [row.state, row.receipt_json, row.receipt_mac, built.sessionId, first.actionId]);
        expect((await host.request("player-followups", followup(view, "tamper-restored", "你刚才说的那个呢？", first.actionId))).status).toBe(200);
        expect(calls).toBe(2);
      } finally { db.close(true); adb.close(true); }
    } finally { if (host) await host.stop(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("revalidates a prepared request's predecessor before resuming provider dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-followup-continuity-prepared-"));
    let host: ReturnType<typeof startHost> | undefined;
    try {
      const built = await createContactSession(root);
      let calls = 0;
      const llm: LLMLike = { async chat() { calls += 1; return '{"text":"我只知道石头能带你到外面去。"}'; } };
      host = startHost(built, llm);
      const view = await host.talk();
      const first = followup(view, "prepared-first", "那块石头有什么用？");
      expect((await host.request("player-followups", first)).status).toBe(200);
      const second = followup(view, "prepared-second", "你刚才说的那个呢？", first.actionId);
      host.runtime.compiledFollowupOptions = { isLlmEnabled: () => false };
      expect((await host.request("player-followups", second)).status).toBe(503);
      const prepared = host.ledger.read(built.sessionId, second.actionId);
      if (prepared.status !== "ok") throw new Error("prepared continuity request lost its durable record");
      expect(prepared.value.state).toBe("prepared");
      expect(host.admission.read(built.sessionId, second.actionId).status).toBe("absent");
      host.runtime.compiledFollowupOptions = { llm, isLlmEnabled: () => true };
      expect((await host.request("player-followups", second)).status).toBe(200);
      expect(calls).toBe(2);
      const pending = followup(view, "prepared-pending", "再说说你刚才说的那个？", first.actionId);
      host.runtime.compiledFollowupOptions = { isLlmEnabled: () => false };
      expect((await host.request("player-followups", pending)).status).toBe(503);
      const db = new Database(host.ledger.file);
      try { db.run("DELETE FROM compiled_player_followup_records WHERE session_id = ? AND action_id = ?", [built.sessionId, first.actionId]); } finally { db.close(true); }
      host.runtime.compiledFollowupOptions = { llm, isLlmEnabled: () => true };
      expect((await host.request("player-followups", pending)).status).toBe(409);
      expect(host.admission.read(built.sessionId, pending.actionId).status).toBe("absent");
      expect(calls).toBe(2);
    } finally { if (host) await host.stop(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("replays after a real host rebuild and predecessor deletion, while new dispatch still needs a trusted predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-followup-continuity-restart-"));
    let host: ReturnType<typeof startHost> | undefined;
    try {
      const built = await createContactSession(root);
      let calls = 0;
      const prompts: Message[][] = [];
      const llm: LLMLike = { async chat(messages) { calls += 1; prompts.push(structuredClone(messages)); return JSON.stringify({ text: `这是第${calls}次回答，我只知道那块石头能带你到外面去。` }); } };
      host = startHost(built, llm);
      const view = await host.talk();
      const first = followup(view, "restart-first", "那块石头有什么用？");
      const second = followup(view, "restart-second", "你刚才说的那个呢？", first.actionId);
      expect((await host.request("player-followups", first)).status).toBe(200);
      const secondResponse = await host.request("player-followups", second);
      expect(secondResponse.status).toBe(200);
      const secondAnswer = (await secondResponse.json() as { followup: { text: string } }).followup;
      await host.stop();
      host = startHost(built, llm, true);
      host.runtime.compiledFollowupOptions = { isLlmEnabled: () => false };
      const replay = await host.request("player-followups", second);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: "replayed", followup: secondAnswer });
      expect(calls).toBe(2);
      const db = new Database(host.ledger.file);
      try { db.run("DELETE FROM compiled_player_followup_records WHERE session_id = ? AND action_id = ?", [built.sessionId, first.actionId]); } finally { db.close(true); }
      const replayWithoutPredecessor = await host.request("player-followups", second);
      expect(replayWithoutPredecessor.status).toBe(200);
      expect(await replayWithoutPredecessor.json()).toMatchObject({ status: "replayed", followup: secondAnswer });
      expect(calls).toBe(2);
      host.runtime.compiledFollowupOptions = { llm, isLlmEnabled: () => true };
      expect((await host.request("player-followups", followup(view, "restart-missing", "那又意味着什么？", first.actionId))).status).toBe(409);
      expect((await host.request("player-followups", { ...second, previousActionId: "absent-action" })).status).toBe(409);
      expect((await host.request("player-followups", { ...second, playerInput: "修改了原问句。" })).status).toBe(409);
      expect(calls).toBe(2);
      // Only the immediate second exchange is restored: its deleted ancestor
      // must not become an unbounded historical dependency.
      expect((await host.request("player-followups", followup(view, "restart-third", "那又意味着什么？", second.actionId))).status).toBe(200);
      expect(calls).toBe(3);
      expect(promptBody(prompts[2]!)).toMatchObject({ previousTurn: { playerQuestion: second.playerInput, contactReply: secondAnswer.text } });
      expect(JSON.stringify(promptBody(prompts[2]!))).not.toContain(first.playerInput);
    } finally { if (host) await host.stop(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("keeps legacy exact replay and prepared recovery but refuses legacy rows as a prior exchange", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-followup-continuity-legacy-"));
    let host: ReturnType<typeof startHost> | undefined;
    try {
      const built = await createContactSession(root);
      let calls = 0;
      host = startHost(built, { async chat() { calls += 1; return '{"text":"我只知道那块石头能带你到外面去。"}'; } });
      const view = await host.talk();
      const old = followup(view, "legacy-settled", "那块石头有什么用？");
      seedLegacy(host, built, old);
      const replay = await host.request("player-followups", old);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: "replayed" });
      expect((await host.request("player-followups", followup(view, "legacy-next", "你刚才说的那个呢？", old.actionId))).status).toBe(409);
      expect(calls).toBe(0);
      const prepared = followup(view, "legacy-prepared", "那块石头有什么用？");
      seedLegacy(host, built, prepared, false);
      expect((await host.request("player-followups", prepared)).status).toBe(200);
      expect(calls).toBe(1);
      const persisted = host.ledger.read(built.sessionId, prepared.actionId);
      if (persisted.status !== "ok") throw new Error("legacy prepared recovery lost its record");
      expect(persisted.value.record.schemaVersion).toBe("1.0.0");
    } finally { if (host) await host.stop(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("bounds one prior exchange and rejects caller-authored context or self references", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-followup-continuity-bound-"));
    let host: ReturnType<typeof startHost> | undefined;
    try {
      const built = await createContactSession(root);
      const prompts: Message[][] = [];
      host = startHost(built, { async chat(messages) { prompts.push(structuredClone(messages)); return JSON.stringify({ text: "答".repeat(2_000) }); } });
      const view = await host.talk();
      const first = followup(view, "bounded-first", "问".repeat(1_000));
      expect((await host.request("player-followups", first)).status).toBe(200);
      const second = followup(view, "bounded-second", "问".repeat(1_000), first.actionId);
      expect((await host.request("player-followups", second)).status).toBe(200);
      expect(promptBody(prompts[1]!)).toMatchObject({ previousTurn: { playerQuestion: first.playerInput, contactReply: "答".repeat(2_000) } });
      for (const changed of [
        { playerInput: "问".repeat(1_001) }, { contextHash: "a".repeat(64) },
        { previousTurn: { playerQuestion: "forged", contactReply: "forged" } },
        { previousActionId: "bounded-invalid" }, { previousActionId: null }, { previousActionId: "" },
      ]) {
        expect((await host.request("player-followups", { ...followup(view, "bounded-invalid", "你说的那个？"), ...changed })).status).toBe(400);
      }
      expect(prompts).toHaveLength(2);
    } finally { if (host) await host.stop(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects a prior contact once a real action changes the released fact scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-followup-continuity-stale-"));
    let host: ReturnType<typeof startHost> | undefined;
    try {
      const built = await createContactSession(root, "machine", { pages: NPC_CONTACT_MULTI_PAGES, dialogues: NPC_CONTACT_MULTI_DIALOGUES });
      let calls = 0;
      host = startHost(built, { async chat() { calls += 1; return '{"text":"我只知道那块石头能带你到外面去。"}'; } });
      const firstView = await host.talk();
      const first = followup(firstView, "stale-first", "那块石头有什么用？");
      expect((await host.request("player-followups", first)).status).toBe(200);
      const secondView = await host.talk("continuity-talk-0002");
      expect(secondView.generation).toBeGreaterThan(firstView.generation);
      expect((await host.request("player-followups", followup(secondView, "stale-next", "你刚才说的那个呢？", first.actionId))).status).toBe(409);
      expect((await host.request("player-followups", first)).status).toBe(409);
      expect(calls).toBe(1);
    } finally { if (host) await host.stop(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("preserves terminal exact replay while refusing a new same-generation followup", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-followup-continuity-terminal-"));
    let host: ReturnType<typeof startHost> | undefined;
    try {
      const built = await createContactSession(root, "machine", { pages: NPC_CONTACT_TERMINAL_PAGES, dialogues: NPC_CONTACT_TERMINAL_DIALOGUES, terminalAfterDialogueIndex: 1 });
      let calls = 0;
      host = startHost(built, { async chat() { calls += 1; return '{"text":"我知道的就这些。"}'; } });
      await host.talk();
      const view = await host.talk("continuity-talk-0002");
      expect(view.terminal).toBe(true);
      const historic = followup(view, "terminal-historic", "那块石头有什么用？");
      seedLegacy(host, built, historic);
      const replay = await host.request("player-followups", historic);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: "replayed" });
      expect((await host.request("player-followups", followup(view, "terminal-new", "还能继续吗？", historic.actionId))).status).toBe(409);
      expect(calls).toBe(0);
    } finally { if (host) await host.stop(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
