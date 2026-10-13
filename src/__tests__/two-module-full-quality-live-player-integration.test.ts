import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runLiveTwoModuleHttpCampaignHost,
  type TwoModuleHttpCampaignHostDocument,
} from "../../scripts/diag/two-module-http-campaign-host";
import { requestCompilerHintProposals } from "../api/compiler-hint-proposal-adapter";
import { CompiledPlayerDelivery } from "../api/player-delivery";
import { SERVER_AUTO_COMPILER_POLICY } from "../api/server";
import { prepareCompiler } from "../compiler/compiler-api";
import { sha256 } from "../ingest/document-ir";
import { CompiledWorldModelBindingRegistry } from "../world/compiled-world-model-binding-registry";

const DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";
const PROVIDER_BASE_URL = "https://full-quality-route-test.invalid/v1";
const PROVIDER_URL = `${PROVIDER_BASE_URL}/chat/completions`;

type PromptQuestion = {
  questionId: string;
  kind: string;
  sourceStatements: Array<{ statementId: string; text: string }>;
  candidateDomains: {
    subjectCandidateId?: string;
    allowedLocationCandidateIds?: string[];
    allowedMechanicsTargetIds?: Record<string, string[]>;
    allowedItemNameEvidenceStatementIds?: string[];
    allowedDispositions?: Array<"source_only" | "mechanics_candidate">;
    allowedClueFactAtoms?: Array<{ atomId: string; statementId: string; quote: string }>;
  };
};

type PromptEnvelope = {
  questions: PromptQuestion[];
  candidateCatalog: Array<{ id: string; kind: string; label: string }>;
};

type SelectorSlot = {
  fieldPath: string;
  expectedAudience: "public_on_entry" | "found_clue" | "terminal_only" | "private_context";
  candidates: Array<{ candidateDigest: string; exactText: string }>;
  opaqueCandidateDigest: string | null;
  eligibility: { forbiddenCandidateDigests: string[] };
};

function structuredPdfBytes(lines: readonly { text: string; size: number; x: number; y: number }[]): Uint8Array {
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

function npcSourcePdf(title: string, terminal: string, npcInSecondScene = false): Uint8Array {
  return structuredPdfBytes([
    { text: title, size: 22, x: 72, y: 742 },
    { text: "ENTRY:", size: 16, x: 72, y: 690 },
    ...(!npcInSecondScene ? [{ text: "Captain Mira waits beside the launch and says the dream stone opens the exit.", size: 6, x: 72, y: 666 }] : []),
    { text: "ARCHIVE:", size: 16, x: 72, y: 630 },
    ...(npcInSecondScene ? [{ text: "Captain Mira waits beside the launch and says the dream stone opens the exit.", size: 6, x: 72, y: 606 }] : []),
    { text: "\u25b6Dream Stone: The dream stone opens the exit.", size: 6, x: 72, y: npcInSecondScene ? 582 : 606 },
    { text: "EXIT:", size: 16, x: 72, y: npcInSecondScene ? 546 : 570 },
    { text: "ENDING:", size: 16, x: 72, y: npcInSecondScene ? 510 : 534 },
    { text: terminal, size: 6, x: 72, y: npcInSecondScene ? 486 : 510 },
  ]);
}

const documents: readonly TwoModuleHttpCampaignHostDocument[] = [
  { id: "fuzu", moduleId: "full-quality-route-fuzu", path: "memory://full-quality-route-fuzu.pdf" },
  { id: "barn", moduleId: "full-quality-route-barn", path: "memory://full-quality-route-barn.pdf" },
];

const sourceBytes = new Map<string, Uint8Array>([
  [documents[0]!.path, npcSourcePdf("FUZU CONTACT ROUTE", "The Fuzu investigation closes at the exit.")],
  [documents[1]!.path, npcSourcePdf("BARN CONTACT ROUTE", "The Barn investigation closes at the exit.")],
]);

function readDocument(document: TwoModuleHttpCampaignHostDocument): Uint8Array {
  const bytes = sourceBytes.get(document.path);
  if (!bytes) throw new Error("missing route integration PDF");
  return new Uint8Array(bytes);
}

function sourceProfileRegistry(): { registry: CompiledWorldModelBindingRegistry; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "two-module-full-quality-live-route-"));
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify({
    schemaVersion: "1.1.0",
    kind: "compiled_cthulhu_world_model_policy",
    bindings: [],
    sourceProfiles: documents.map((document, index) => ({
      moduleId: document.moduleId,
      documentHash: sha256(readDocument(document)),
      allowedWorkIds: [index === 0 ? "the_call_of_cthulhu" : "the_dunwich_horror"],
      corpusScopeId: null,
      transferPolicy: "analogy_only",
    })),
  }), "utf8");
  return {
    registry: new CompiledWorldModelBindingRegistry({
      COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: policyPath,
      CTHULHU_DATASET_PATH: DATASET_ROOT,
    }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function promptEnvelope(messages: unknown): PromptEnvelope {
  if (!Array.isArray(messages)) throw new Error("fake provider lacks messages");
  const last = messages.at(-1);
  const content = last && typeof last === "object" && !Array.isArray(last)
    ? (last as { content?: unknown }).content : undefined;
  if (typeof content !== "string") throw new Error("fake provider lacks prompt text");
  const marker = "REQUEST ENVELOPE:\n";
  const start = content.lastIndexOf(marker);
  if (start < 0) throw new Error("fake provider lacks compiler envelope");
  return JSON.parse(content.slice(start + marker.length)) as PromptEnvelope;
}

function normalizedSceneLabel(label: string): string {
  return label.trim().replace(/:$/, "").toLocaleLowerCase();
}

function citation(question: PromptQuestion, claimKey: string, longest = false) {
  const source = longest
    ? question.sourceStatements.reduce<PromptQuestion["sourceStatements"][number] | undefined>(
      (chosen, value) => !chosen || value.text.length > chosen.text.length ? value : chosen,
      undefined,
    )
    : question.sourceStatements[0];
  if (!source) throw new Error(`queue question has no source: ${question.kind}`);
  return { claimKey, statementId: source.statementId, quote: source.text };
}

function compilerReply(messages: unknown, observeKinds?: (kinds: string) => void): string {
  const envelope = promptEnvelope(messages);
  observeKinds?.([...new Set(envelope.questions.map((question) => question.kind))].sort().join(","));
  const scenes = envelope.candidateCatalog.filter((candidate) => candidate.kind === "scene");
  const entry = scenes.find((candidate) => normalizedSceneLabel(candidate.label).startsWith("entry"));
  const exit = scenes.find((candidate) => normalizedSceneLabel(candidate.label).startsWith("exit"));
  const proposals = envelope.questions.map((question) => {
    const subject = question.candidateDomains.subjectCandidateId;
    switch (question.kind) {
      case "scene_role": {
        const scene = subject && scenes.find((candidate) => candidate.id === subject);
        if (!scene) throw new Error("scene role lacks a scene");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { role: normalizedSceneLabel(scene.label) === "ending" ? "ending_section" : "playable_scene" },
          citations: [citation(question, "scene_role")],
        };
      }
      case "entry_scene":
        if (!entry) throw new Error("entry scene missing");
        return { questionId: question.questionId, kind: question.kind, value: { sceneCandidateId: entry.id }, citations: [citation(question, "entry_scene")] };
      case "connection_topology": {
        const source = subject && scenes.find((candidate) => candidate.id === subject);
        if (!source) throw new Error("topology source missing");
        const target = normalizedSceneLabel(source.label).startsWith("entry")
          ? scenes.find((candidate) => candidate.id !== source.id && !normalizedSceneLabel(candidate.label).startsWith("exit") && normalizedSceneLabel(candidate.label) !== "ending") ?? exit
          : normalizedSceneLabel(source.label).startsWith("exit") || normalizedSceneLabel(source.label) === "ending" ? undefined : exit;
        const connectionId = `route_connection_${question.questionId.slice(-8)}`;
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { connections: target ? [{ toSceneCandidateId: target.id, connectionId }] : [] },
          citations: [citation(question, target ? `connection:${connectionId}` : "topology")],
        };
      }
      case "core_clue":
        if (!subject) throw new Error("core clue missing subject");
        return { questionId: question.questionId, kind: question.kind, value: { clueCandidateId: subject, required: true }, citations: [citation(question, "core_clue")] };
      case "clue_fact_facets": {
        if (!subject) throw new Error("clue facts missing subject");
        const atoms = question.candidateDomains.allowedClueFactAtoms;
        if (!atoms?.length) throw new Error("clue facts missing atoms");
        const finding = atoms.at(-1)!;
        const shell = atoms.slice(0, -1);
        const findingKey = `route_finding_${question.questionId.slice(-8)}`;
        const declarationKey = `route_search_${question.questionId.slice(-8)}`;
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: {
            shell: shell.map((atom) => ({ atomId: atom.atomId, quote: atom.quote })),
            findings: [{
              findingKey,
              atoms: [{ atomId: finding.atomId, quote: finding.quote }],
              methods: [{ declarationKey, action: "search", target: "clue", check: { kind: "none" } }],
            }],
            sourceOnlyAtomIds: [],
          },
          citations: [
            ...shell.map((atom) => ({ claimKey: `clue_fact_shell:${subject}:${atom.atomId}`, statementId: atom.statementId, quote: atom.quote })),
            { claimKey: `clue_fact_finding:${findingKey}:${finding.atomId}`, statementId: finding.statementId, quote: finding.quote },
            { claimKey: `clue_fact_method:${findingKey}:${declarationKey}`, statementId: finding.statementId, quote: finding.quote },
          ],
        };
      }
      case "discovery_method": {
        const locationSceneCandidateId = question.candidateDomains.allowedLocationCandidateIds?.[0];
        const targetId = question.candidateDomains.allowedMechanicsTargetIds?.scene?.[0];
        if (!subject || !locationSceneCandidateId || !targetId) throw new Error("discovery domain missing");
        const methodId = `route_discovery_${question.questionId.slice(-8)}`;
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { clueCandidateId: subject, locationSceneCandidateId, spec: {
            kind: "discovery_method", id: methodId, clueId: subject, action: "search", target: "scene", targetId,
            onSuccess: [{ kind: "discover_clue", clueId: subject }],
          } },
          citations: [citation(question, `discovery:${methodId}`)],
        };
      }
      case "item_binding":
        if (!subject) throw new Error("item binding missing subject");
        {
          const nameStatementId = question.candidateDomains.allowedItemNameEvidenceStatementIds?.[0];
          const name = nameStatementId && question.sourceStatements.find((statement) => statement.statementId === nameStatementId);
          if (!name) throw new Error("item binding lacks exact name evidence");
          return { questionId: question.questionId, kind: question.kind, value: { itemCandidateId: subject, itemType: null }, citations: [{ claimKey: `item_binding:none:${subject}`, statementId: name.statementId, quote: name.text }] };
        }
      case "ending_rule": {
        if (!exit) throw new Error("ending rule missing exit");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { declarations: [{ endingId: "route_exit", spec: {
            kind: "ending_rule", id: "route_exit_rule", priority: 1,
            when: { kind: "scene_visited", sceneId: exit.id }, effects: [{ kind: "end_game", endingId: "route_exit" }],
          } }] },
          citations: [citation(question, "ending:route_exit", true)],
        };
      }
      case "npc_binding": {
        if (!subject) throw new Error("NPC binding missing anchor");
        const source = question.sourceStatements.find((candidate) => candidate.text.includes("Captain Mira"));
        // Answer every exact prose anchor, including newly eligible non-NPC
        // paragraphs after scene roles resolve. An empty binding is a legal
        // source declaration; it must not become a provider transport failure.
        if (!source) return {
          questionId: question.questionId,
          kind: question.kind,
          value: { proseAnchorId: subject, presentNpcs: [] },
          citations: [citation(question, `npc_binding:none:${subject}`)],
        };
        const relationship = "the dream stone opens the exit";
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { proseAnchorId: subject, presentNpcs: [{ nameQuote: "Mira", dialogueMethods: [{ relationshipEvidence: { statementId: source.statementId, quote: relationship } }] }] },
          citations: [
            { claimKey: `npc_binding:${subject}:0:name`, statementId: source.statementId, quote: "Mira" },
            { claimKey: `npc_binding:${subject}:0:relationship:0`, statementId: source.statementId, quote: relationship },
          ],
        };
      }
      case "source_fact_disposition": {
        const source = question.sourceStatements[0];
        if (!source) throw new Error("source disposition missing statement");
        const disposition = question.candidateDomains.allowedDispositions?.includes("source_only")
          ? "source_only"
          : question.candidateDomains.allowedDispositions?.includes("mechanics_candidate")
            ? "mechanics_candidate"
            : undefined;
        if (!disposition) throw new Error("source disposition domain missing");
        return { questionId: question.questionId, kind: question.kind, value: { statementId: source.statementId, disposition }, citations: [citation(question, `source_fact_disposition:${source.statementId}`)] };
      }
      default:
        throw new Error(`unhandled compiler queue kind: ${question.kind}`);
    }
  });
  return JSON.stringify({ proposals });
}

function selectorReply(payload: { slots: SelectorSlot[] }): string {
  const selections = payload.slots.map((slot) => {
    const eligible = slot.candidates.filter((candidate) => !slot.eligibility.forbiddenCandidateDigests.includes(candidate.candidateDigest));
    const find = (pattern: RegExp) => eligible.find((candidate) => pattern.test(candidate.exactText));
    const source = slot.expectedAudience === "terminal_only"
      ? find(/investigation closes/i) ?? eligible[0]
      : /^npcs\.[^.]+\.name$/.test(slot.fieldPath)
        ? find(/^Mira$/) ?? eligible[0]
        : /^scenes\.[^.]+\.name$/.test(slot.fieldPath)
          ? find(/^(ENTRY|ARCHIVE|EXIT)$/i) ?? eligible[0]
          : eligible[0];
    if (source) return {
      fieldPath: slot.fieldPath,
      kind: "source_exact",
      candidateDigest: source.candidateDigest,
      audience: slot.expectedAudience,
    };
    if (!slot.opaqueCandidateDigest) throw new Error(`selector lacks canonical choice: ${slot.fieldPath}`);
    return { fieldPath: slot.fieldPath, kind: "opaque_unavailable", candidateDigest: slot.opaqueCandidateDigest, audience: slot.expectedAudience };
  });
  return JSON.stringify({ selections });
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Temporary test-local validator trace for a host report that deliberately
 * exposes no adapter diagnostics. It recreates the exact PDF -> graph ->
 * prepared queue boundary and returns codes only: no source text, prompt,
 * endpoint, or credential escapes this test.
 */
async function compilerValidationCodes(): Promise<string> {
  const summaries: string[] = [];
  for (const document of documents) {
    const prepared = await prepareCompiler({
      kind: "pdf_bytes",
      moduleId: document.moduleId,
      pdfBytes: readDocument(document),
    });
    if (prepared.status !== "prepared") {
      summaries.push(`${document.id}:prepare:${prepared.code}`);
      continue;
    }
    const result = await requestCompilerHintProposals({
      graph: prepared.artifact.payload.graph,
      queue: prepared.artifact.payload.preparedQueue,
      llm: { chat: async (messages) => compilerReply(messages) },
      policy: SERVER_AUTO_COMPILER_POLICY,
      producer: { providerFingerprint: "test:full-quality-route", modelFingerprint: "test:full-quality-route" },
      limits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxResponseTokens: 2_400 },
    });
    const kindsByQuestionId = new Map(prepared.artifact.payload.preparedQueue.questions.map((question) => [question.id, question.kind]));
    const rejected = result.rejected.map((diagnostic) => `${diagnostic.questionId ? kindsByQuestionId.get(diagnostic.questionId) ?? "unknown" : "batch"}:${diagnostic.code}`).sort();
    const failedChunks = result.calls
      .filter((call) => call.status === "failed")
      .map((call) => call.questionIds.map((questionId) => kindsByQuestionId.get(questionId) ?? "unknown").sort().join("+"));
    summaries.push(`${document.id}:${result.status}:accepted=${result.accepted.length}:rejected=${rejected.join(",") || "none"}:failed=${failedChunks.join(",") || "none"}`);
  }
  return summaries.join(";");
}

for (const npcInSecondScene of [false, true]) {
test(`full-quality live host routes two source-bound PDFs through fake provider compiler, player intent, narration, and followups${npcInSecondScene ? " after navigation to the second-scene NPC" : ""}`, async () => {
  const originalFetch = globalThis.fetch;
  sourceBytes.set(documents[0]!.path, npcSourcePdf("FUZU CONTACT ROUTE", "The Fuzu investigation closes at the exit.", npcInSecondScene));
  sourceBytes.set(documents[1]!.path, npcSourcePdf("BARN CONTACT ROUTE", "The Barn investigation closes at the exit.", npcInSecondScene));
  const profiles = sourceProfileRegistry();
  const calls = { compiler: 0, selector: 0, playerIntent: 0, narration: 0, followup: 0, unknown: 0 };
  const followupReplies: string[] = [];
  const followupFrames: Record<string, unknown>[] = [];
  const compilerBatches: string[] = [];
  const autoDiagnostics: string[] = [];
  const intentGenerations: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(PROVIDER_URL);
    const request = JSON.parse(String(init?.body)) as { messages?: unknown; max_tokens: number };
    expect(request.max_tokens).toBeLessThanOrEqual(1_000);
    const messages = request.messages;
    const last = Array.isArray(messages) ? messages.at(-1) : undefined;
    const content = last && typeof last === "object" && !Array.isArray(last) ? (last as { content?: unknown }).content : undefined;
    if (typeof content !== "string") throw new Error("fake provider request lacks a final message");
    if (content.includes("REQUEST ENVELOPE:\n")) {
      calls.compiler++;
      return completion(compilerReply(messages, (kinds) => compilerBatches.push(kinds)));
    }
    let payload: unknown;
    try { payload = JSON.parse(content); } catch { payload = undefined; }
    if (payload && typeof payload === "object" && !Array.isArray(payload)
      && (payload as { schemaVersion?: unknown }).schemaVersion === "server-machine-presentation-selector-v1") {
      calls.selector++;
      expect(request.max_tokens).toBe(1_000);
      return completion(selectorReply(payload as { slots: SelectorSlot[] }));
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)
      && Array.isArray((payload as { availableActions?: unknown }).availableActions)) {
      calls.playerIntent++;
      expect(request.max_tokens).toBe(128);
      intentGenerations.push((payload as { expectedGeneration: number }).expectedGeneration);
      const talks = (payload as { availableActions: unknown[] }).availableActions.filter((candidate): candidate is { mechanismId: string; label: string } =>
        !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && typeof (candidate as { mechanismId?: unknown }).mechanismId === "string"
        && typeof (candidate as { label?: unknown }).label === "string"
        && (candidate as { label: string }).label.startsWith("Talk to "));
      if (talks.length !== 1) return completion(JSON.stringify({ kind: "no_match" }));
      return completion(JSON.stringify({ kind: "selected", mechanismId: talks[0]!.mechanismId }));
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)
      && typeof (payload as { contact?: unknown }).contact === "string"
      && Array.isArray((payload as { releasedFacts?: unknown }).releasedFacts)) {
      calls.followup++;
      expect(request.max_tokens).toBe(600);
      const facts = (payload as { releasedFacts: unknown[] }).releasedFacts;
      const reply = typeof facts[0] === "string" ? facts[0] : "The source has no released fact.";
      followupReplies.push(reply);
      followupFrames.push(payload as Record<string, unknown>);
      return completion(JSON.stringify({ text: reply }));
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)
      && "actionLabel" in payload) {
      calls.narration++;
      expect(request.max_tokens).toBe(600);
      return completion(JSON.stringify({ text: "Mira considers the question beside the launch." }));
    }
    calls.unknown++;
    throw new Error("fake provider received an unsupported bounded prompt");
  }) as unknown as typeof fetch;
  try {
    const report = await runLiveTwoModuleHttpCampaignHost({
      documents,
      allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
      readDocument,
      machinePublicationEnabled: true,
      requirePublishedWorldModelBinding: true,
      worldModelBindingRegistry: profiles.registry,
      config: { apiKey: "sk-full-quality-route-test", baseUrl: PROVIDER_BASE_URL, model: "fake-quality-route", maxTokens: 2_400, temperature: 0 },
      fullQuality: {
        mode: "full_quality",
        playerDelivery: new CompiledPlayerDelivery({ secret: "b".repeat(43), publicOrigin: "https://full-quality-route.test" }),
      },
      observeAutoResolveResponse: (observation) => {
        autoDiagnostics.push(`${observation.status}:${observation.errorCode ?? "none"}:${observation.diagnostics.map((diagnostic) => `${diagnostic.stage ?? "none"}:${diagnostic.code}`).sort().join(",") || "none"}`);
      },
    });
    expect(report.preflightReason).toBe("ready");
    if (!report.campaign.modules.every((module) => module.status === "published_consumed")) {
      const outcomes = report.campaign.modules.map((module) => `${module.status}:${module.code ?? "none"}:${module.autoResolveAttempts}:${module.reportedProposalCalls}`);
      const validation = await compilerValidationCodes();
      throw new Error(`full-quality fixture did not publish: ${outcomes.join(",")}; fetch=${report.budget.observedExternalFetchDispatches}/${report.budget.reservedOutputTokens}; compiler=${calls.compiler}; selector=${calls.selector}; intent=${calls.playerIntent}; narration=${calls.narration}; followup=${calls.followup}; unknown=${calls.unknown}; questionKinds=${compilerBatches.join("|")}; actualDiagnostics=${autoDiagnostics.join("|")}; validation=${validation}`);
    }
    expect(report.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
    expect(report.host.publishedBundleConsumptions).toBe(2);
    expect(report.host.publishedWorldModelBoundSessionCreations).toBe(2);
    expect(report.host.publishedWorldModelReceiptWitnesses).toBe(2);
    expect(new Set(report.host.publishedWorldModelScopeHashes).size).toBe(2);
    expect(calls.compiler).toBeGreaterThanOrEqual(2);
    expect(calls.selector).toBeGreaterThanOrEqual(2);
    expect(calls.playerIntent).toBe(2);
    expect(calls.narration).toBe(2);
    expect(calls.followup).toBe(4);
    expect(calls.unknown).toBe(0);
    expect(intentGenerations).toEqual(npcInSecondScene ? [1, 1] : [0, 0]);
    expect(followupReplies).toHaveLength(4);
    expect(followupFrames).toHaveLength(4);
    for (const offset of [0, 2]) {
      const firstFrame = followupFrames[offset]!;
      const secondFrame = followupFrames[offset + 1]!;
      expect(firstFrame).not.toHaveProperty("previousTurn");
      expect(secondFrame.previousTurn).toEqual({
        playerQuestion: firstFrame.playerQuestion,
        contactReply: followupReplies[offset],
      });
      expect(secondFrame.playerQuestion).toBe("Could you explain what you just told me a little more?");
      expect(String(secondFrame.playerQuestion).includes(followupReplies[offset]!)).toBeFalse();
      expect(secondFrame.releasedFacts).toEqual(firstFrame.releasedFacts);
      expect(secondFrame.contact).toBe(firstFrame.contact);
    }
    expect(report.budget.observedExternalFetchDispatches).toBe(calls.compiler + calls.selector + calls.playerIntent + calls.narration + calls.followup);
    expect(report.budget.reservedOutputTokens).toBeGreaterThanOrEqual(2 * (128 + 600 + 600 + 600));
  } finally {
    globalThis.fetch = originalFetch;
    profiles.dispose();
  }
}, 30_000);
}
