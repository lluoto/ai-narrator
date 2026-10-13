import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompiledPlayerDelivery } from "../api/player-delivery";
import { handleRequest } from "../api/server";
import { validateCompiledSessionSnapshot, type CompiledSessionSnapshot } from "../api/compiled-session-snapshot";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import type { LLMLike, Message, ChatOptions } from "../llm/client";
import {
  createNpcContactSessionFixture,
} from "./helpers/compiled-npc-contact-fixture";
import {
  consumePublishedBundleForQualityTest,
} from "../../scripts/diag/two-module-http-campaign-host";

const owner: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "keeper:full-quality-route" },
});

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("expected player claim to issue a cookie");
  return value.split(";", 1)[0]!;
}

type PlayerQualityObservation = {
  intentCalls: number;
  narrationCalls: number;
  followupCalls: number;
  followupQuestions: string[];
  followupReplies: string[];
  followupPreviousTurns: unknown[];
  contactNames: string[];
  releasedFactFrames: string[];
};

function fullQualityPlayerLlm(observation: PlayerQualityObservation): LLMLike {
  return {
    async chat(messages: Message[], options?: ChatOptions): Promise<string> {
      const raw = messages.at(-1)?.content;
      let payload: unknown;
      try { payload = typeof raw === "string" ? JSON.parse(raw) : undefined; } catch { return "{}"; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "{}";
      if (options?.workload === "intent") {
        observation.intentCalls += 1;
        const actions = (payload as { availableActions?: unknown }).availableActions;
        const talks = Array.isArray(actions) ? actions.filter((candidate): candidate is { mechanismId: string; label: string } =>
          !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
          && typeof (candidate as { mechanismId?: unknown }).mechanismId === "string"
          && typeof (candidate as { label?: unknown }).label === "string"
          && (candidate as { label: string }).label.startsWith("Talk to ")) : [];
        return talks.length === 1
          ? JSON.stringify({ kind: "selected", mechanismId: talks[0]!.mechanismId })
          : JSON.stringify({ kind: "no_match" });
      }
      if ("contact" in payload && "releasedFacts" in payload) {
        observation.followupCalls += 1;
        const facts = (payload as { releasedFacts?: unknown }).releasedFacts;
        const contact = (payload as { contact?: unknown }).contact;
        const playerQuestion = (payload as { playerQuestion?: unknown }).playerQuestion;
        const reply = Array.isArray(facts) && typeof facts[0] === "string" ? facts[0] : "I do not know.";
        if (typeof contact === "string" && typeof playerQuestion === "string") {
          observation.contactNames.push(contact);
          observation.followupQuestions.push(playerQuestion);
          observation.followupReplies.push(reply);
          observation.followupPreviousTurns.push((payload as { previousTurn?: unknown }).previousTurn);
          observation.releasedFactFrames.push(JSON.stringify(facts));
        }
        return JSON.stringify({ text: reply });
      }
      observation.narrationCalls += 1;
      return JSON.stringify({ text: "Mira pauses beside the launch." });
    },
  };
}

function expectTrustedFollowupContinuity(observation: PlayerQualityObservation): void {
  expect(observation.followupPreviousTurns).toEqual([
    undefined,
    { playerQuestion: observation.followupQuestions[0], contactReply: observation.followupReplies[0] },
  ]);
  expect(observation.followupQuestions[1]).toBe("Could you explain what you just told me a little more?");
  expect(observation.followupQuestions[1]?.includes(observation.followupReplies[0] ?? "")).toBeFalse();
}

/** Mirrors the host's verified Type0/ToUnicode PDF layout for real DocIR input. */
function npcContactPdf(entryBeforeContact = false): Uint8Array {
  const lines = [
    { text: "NPC CONTACT FIXTURE", size: 22, x: 72, y: 742 },
    ...(entryBeforeContact ? [{ text: "Entry:", size: 16, x: 72, y: 716 }] : []),
    { text: "Dock:", size: 16, x: 72, y: 690 },
    { text: "Captain Mira waits beside the launch and says the stone can take you outside.", size: 6, x: 72, y: 666 },
    { text: "Archive:", size: 16, x: 72, y: 630 },
    { text: "\u25b6Dream Stone: The dream stone opens the exit.", size: 6, x: 72, y: 606 },
    { text: "Exit:", size: 16, x: 72, y: 570 },
  ];
  const hex = (value: string) => [...value].map((character) => character.codePointAt(0)!.toString(16).padStart(4, "0")).join("");
  const stream = lines.map((line) => `BT\n/F1 ${line.size} Tf\n${line.x} ${line.y} Td\n<${hex(line.text)}> Tj\nET\n`).join("");
  const byteLength = (value: string) => new TextEncoder().encode(value).length;
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>",
    `<< /Length ${byteLength(cmap)} >>\nstream\n${cmap}endstream`,
    "<< /Type /FontDescriptor /FontName /Helvetica /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

// Real PDF preparation, machine publication and both session/claim paths
// precede durable intent, action and followup verification. This bounded
// whole-fixture timeout is not a product request deadline or latency SLO.
test("full-quality host consumption claims an owner-issued invitation before its actual player route phases", async () => {
  const root = mkdtempSync(join(tmpdir(), "two-module-full-quality-player-routes-"));
  const delivery = new CompiledPlayerDelivery({
    secret: "full_quality_player_route_secret_0123456789",
    publicOrigin: "https://full-quality-player.test",
  });
  const createNpcContactSession = createNpcContactSessionFixture(owner);
  const fixture = await createNpcContactSession(root, "machine", {
    playerDelivery: delivery,
    pdfBytes: npcContactPdf(),
  });
  const runtime = {
    registry: new Map(),
    compiledDurableHostCapability: Object.freeze(Object.create(null)) as object,
  };
  try {
    const invitation = fixture.playerInvitation;
    expect(typeof invitation?.invite).toBe("string");
    const invite = invitation!.invite;
    expect(invite).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const claimBody = JSON.stringify({ invite: fixture.playerInvitation!.invite, claimId: "c".repeat(43) });
    const claimRequest = new Request(
      `${delivery.publicOrigin}/api/sessions/${fixture.sessionId}/player-invitations/claim`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: delivery.publicOrigin! },
        body: claimBody,
      },
    );
    expect(claimRequest.headers.get("content-type")).toBe("application/json");
    expect(await claimRequest.clone().json()).toEqual(JSON.parse(claimBody));
    const claim = await handleRequest(claimRequest, fixture.catalog, fixture.snapshots, { careerRoot: join(root, "careers") }, {}, {}, owner,
    undefined, undefined, delivery, undefined, {
      registry: fixture.registry,
      compiledDurableHostCapability: fixture.compiledDurableHostCapability,
    });
    if (claim.status !== 204) throw new Error(`player invitation claim refused: ${claim.status} ${await claim.text()}`);
    expect(claim.status).toBe(204);
    expect(claim.headers.get("set-cookie")).toContain("HttpOnly");
    expect(claim.headers.get("set-cookie")).toContain("Secure");
    expect(claim.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(cookieFrom(claim)).toMatch(/^__Host-aitrpg-p1-[a-f0-9]{32}=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+$/);
    if (!fixture.publication) throw new Error("PDF-backed contact fixture lacks a publication identity");

    const consumerStorage = { careerRoot: join(root, "consumer-careers"), sessionRoot: join(root, "consumer-sessions") };
    mkdirSync(consumerStorage.sessionRoot, { recursive: true });
    const observedPhases: string[] = [];
    const playerQualityObservation: PlayerQualityObservation = {
      intentCalls: 0,
      narrationCalls: 0,
      followupCalls: 0,
      followupQuestions: [],
      followupReplies: [],
      followupPreviousTurns: [],
      contactNames: [],
      releasedFactFrames: [],
    };
    const consumed = await consumePublishedBundleForQualityTest({
      publication: fixture.publication,
      catalog: fixture.catalog,
      snapshots: fixture.snapshots,
      storage: consumerStorage,
      sessionRuntime: runtime,
      playerRoute: {
        delivery,
        llm: fullQualityPlayerLlm(playerQualityObservation),
        async runPhase(context, dispatch) {
          observedPhases.push(context.phase);
          return dispatch();
        },
      },
    });
    expect(observedPhases).toEqual(["player_intent", "narration", "followup", "followup"]);
    expect(consumed.consumed).toBeTrue();
    expect(playerQualityObservation.intentCalls).toBe(1);
    expect(playerQualityObservation.narrationCalls).toBe(1);
    expect(playerQualityObservation.followupCalls).toBe(2);
    expect(playerQualityObservation.followupQuestions).toHaveLength(2);
    expect(new Set(playerQualityObservation.contactNames).size).toBe(1);
    expect(new Set(playerQualityObservation.releasedFactFrames).size).toBe(1);
    expectTrustedFollowupContinuity(playerQualityObservation);
  } finally {
    for (const session of fixture.registry.values()) session.close();
    for (const session of runtime.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("full-quality claimed player navigates from an NPC-free source entry to the original second-scene NPC before using its quality phases", async () => {
  const root = mkdtempSync(join(tmpdir(), "two-module-full-quality-navigation-"));
  const delivery = new CompiledPlayerDelivery({ secret: "n".repeat(43), publicOrigin: "https://full-quality-navigation.test" });
  const fixture = await createNpcContactSessionFixture(owner)(root, "machine", {
    playerDelivery: delivery,
    pdfBytes: npcContactPdf(true),
    entrySceneName: "Entry",
  });
  const runtime = { registry: new Map(), compiledDurableHostCapability: Object.freeze(Object.create(null)) as object };
  const observation: PlayerQualityObservation = {
    intentCalls: 0, narrationCalls: 0, followupCalls: 0,
    followupQuestions: [], followupReplies: [], followupPreviousTurns: [], contactNames: [], releasedFactFrames: [],
  };
  let beforeIntent: CompiledSessionSnapshot | undefined;
  let afterTalk: CompiledSessionSnapshot | undefined;
  let qualitySessionId: string | undefined;
  const snapshot = (sessionId: string): CompiledSessionSnapshot => {
    const stored = fixture.snapshots.read(sessionId);
    if (stored.status !== "ok") throw new Error("navigation witness is not durable");
    const checked = validateCompiledSessionSnapshot(stored.value);
    if (checked.status !== "ok") throw new Error("navigation witness is not valid");
    return checked.value;
  };
  try {
    const initial = fixture.registry.get(fixture.sessionId)!.getCompiledPlayerFacadeView();
    expect(initial.generation).toBe(0);
    expect(initial.actions.some((action) => action.label === "Talk")).toBeFalse();
    expect(initial.actions.filter((action) => action.label === "Go to another area")).toHaveLength(1);
    expect(initial.presentation?.contacts ?? []).toEqual([]);
    const entryId = fixture.payload.analysisInput.entrySceneId;
    const npc = fixture.payload.proseNpcBindings[0];
    expect(npc).toBeDefined();
    expect(npc!.sceneCandidateId).not.toBe(entryId);
    if (!fixture.publication) throw new Error("navigation fixture lacks source publication");
    const storage = { careerRoot: join(root, "consumer-careers"), sessionRoot: join(root, "consumer-sessions") };
    mkdirSync(storage.sessionRoot, { recursive: true });
    const consumed = await consumePublishedBundleForQualityTest({
      publication: fixture.publication, catalog: fixture.catalog, snapshots: fixture.snapshots, storage, sessionRuntime: runtime,
      playerRoute: {
        delivery, llm: fullQualityPlayerLlm(observation),
        async runPhase(context, dispatch) {
          const sessionId = [...runtime.registry.keys()][0];
          if (typeof sessionId !== "string") throw new Error("claimed navigation session missing");
          qualitySessionId = sessionId;
          if (context.phase === "player_intent") beforeIntent = snapshot(sessionId);
          const result = await dispatch();
          if (context.phase === "narration") afterTalk = snapshot(sessionId);
          return result;
        },
      },
    });
    expect(consumed.consumed).toBeTrue();
    expect(consumed.phases).toEqual(["player_intent", "narration", "followup", "followup"]);
    expect(beforeIntent?.generation).toBe(1);
    expect(beforeIntent?.state.currentSceneId).toBe(npc!.sceneCandidateId);
    expect(beforeIntent?.trace.map((edge) => edge.outcome)).toEqual(["traverse"]);
    expect(beforeIntent?.idempotency).toHaveLength(1);
    expect(beforeIntent?.idempotency[0]?.response.action.playerNarration).toBeUndefined();
    expect(afterTalk?.generation).toBe(2);
    expect(afterTalk?.previousSnapshotHash).toBe(beforeIntent?.snapshotHash);
    expect(afterTalk?.trace.slice(beforeIntent!.trace.length).map((edge) => edge.outcome)).toEqual(["success"]);
    expect(afterTalk?.state.foundClueIds).toContain(fixture.proseClue.clueId!);
    expect(observation.intentCalls).toBe(1);
    expect(observation.narrationCalls).toBe(1);
    expect(observation.followupCalls).toBe(2);
    expect(observation.contactNames).toEqual(["Mira", "Mira"]);
    expectTrustedFollowupContinuity(observation);
    const afterConsumer = snapshot(qualitySessionId!);
    expect(afterConsumer.generation).toBe(3);
    expect(afterConsumer.trace[0]?.outcome).toBe("traverse");
    expect(afterConsumer.trace[0]?.afterStateHash).toBe(beforeIntent!.stateHash);
  } finally {
    for (const session of fixture.registry.values()) session.close();
    for (const session of runtime.registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
