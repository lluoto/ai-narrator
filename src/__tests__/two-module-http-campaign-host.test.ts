import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { minimalPdfBytes } from "./helpers/minimal-pdf";
import {
  FULL_QUALITY_HTTP_CAMPAIGN_LIMITS,
  LIVE_HTTP_CAMPAIGN_LIMITS,
  runHostCli,
  runLiveTwoModuleHttpCampaignHost,
  runOfflineTwoModuleHttpCampaignHost,
  type OfflineTwoModuleHttpCampaignHostInput,
  type TwoModuleHttpCampaignHostDocument,
} from "../../scripts/diag/two-module-http-campaign-host";
import { sha256 } from "../ingest/document-ir";
import {
  buildTrustedPresentationReviewCandidatePage,
  buildTrustedPresentationSelectionCandidatePage,
  buildTrustedPresentationSelectionSlotPage,
  machinePresentationSelectionCandidatesShareSourceRange,
  TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE,
  type TrustedPresentationQuotePolicy,
} from "../compiler/compiler-module-data-projection";
import { requestCompilerHintProposals } from "../api/compiler-hint-proposal-adapter";
import { prepareCompiler, resolveCompiler } from "../compiler/compiler-api";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { resolveDraftModule } from "../compiler/compile-hint-resolution";
import { withQueueHash } from "../compiler/compiler-question-queue";
import { createServerMachinePresentationPublisher, MachinePresentationPublisherError } from "../api/compiler-machine-presentation-publisher";
import type { ChatOptions, LLMLike, Message } from "../llm/client";
import { CoCEngine } from "../rules/coc-engine";
import { CompiledPlayerDelivery } from "../api/player-delivery";
import type { CompilerAutoAdmissionController } from "../api/compiler-auto-admission";
import type { CompiledWorldModelBindingResolver, MachinePresentationPublisher, MachinePresentationSelectionInput } from "../api/compiled-module-http";
import {
  createCompiledCthulhuWorldModelBinding,
  type CompiledCthulhuWorldModelBinding,
} from "../world/compiled-world-model-scope";
import { CompiledWorldModelBindingRegistry } from "../world/compiled-world-model-binding-registry";

const CTHULHU_DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";

const documents: readonly TwoModuleHttpCampaignHostDocument[] = [
  { id: "fuzu", moduleId: "host-fuzu", path: "memory://host-fuzu.pdf" },
  { id: "barn", moduleId: "host-barn", path: "memory://host-barn.pdf" },
];

const sources = new Map<string, Uint8Array>([
  ["memory://host-fuzu.pdf", minimalPdfBytes("Entry: the brass key opens the archive. Archive: the exit is beyond the locked door.")],
  ["memory://host-barn.pdf", minimalPdfBytes("Farmhouse: a ledger names the missing owner. Cellar: a locked gate leads outside.")],
]);

/**
 * Unlike the compact no-progress source above, this fixture emits separate
 * positioned title/body operators. Its structure is deliberately verified
 * through the real PDF prepare path before it is ever used for publication.
 */
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

const TERMINAL_EVIDENCE = "Reaching the exit road brings the investigation to its final close.";

function publicationPdf(title: string, includeTerminalEvidence = true): Uint8Array {
  return structuredPdfBytes([
    { text: title, size: 22, x: 72, y: 742 },
    // Explicit ASCII-colon headings exercise the real PDF parser's strict
    // heading path; bare title classification would make this fixture depend
    // on adjacent prose heuristics rather than its intended source structure.
    { text: "ENTRY HALL:", size: 18, x: 72, y: 690 },
    { text: "ARCHIVE:", size: 18, x: 72, y: 630 },
    { text: "EXIT ROAD:", size: 18, x: 72, y: 570 },
    { text: "ENDING:", size: 18, x: 72, y: 510 },
    // This is an ordinary terminal source statement, not a synthetic hint or
    // a selector-only escape. The proposal adapter must still cite it through
    // the real ending_rule question before machine publication can use it.
    ...(includeTerminalEvidence
      ? [{ text: TERMINAL_EVIDENCE, size: 12, x: 72, y: 484 }]
      : []),
  ]);
}

const publicationDocuments: readonly TwoModuleHttpCampaignHostDocument[] = [
  { id: "fuzu", moduleId: "host-publication-fuzu", path: "memory://host-publication-fuzu.pdf" },
  { id: "barn", moduleId: "host-publication-barn", path: "memory://host-publication-barn.pdf" },
];

const publicationSources: ReadonlyMap<string, Uint8Array> = new Map([
  ["memory://host-publication-fuzu.pdf", publicationPdf("THE BRASS ARCHIVE")],
  ["memory://host-publication-barn.pdf", publicationPdf("THE LONELY FARM")],
]);

/** The former headings-only fixture remains a fail-closed source-domain negative. */
const headingOnlyPublicationSources: ReadonlyMap<string, Uint8Array> = new Map([
  ["memory://host-publication-fuzu.pdf", publicationPdf("THE BRASS ARCHIVE", false)],
  ["memory://host-publication-barn.pdf", publicationPdf("THE LONELY FARM", false)],
]);

/**
 * A real PDF/DocIR fixture with a source-bound core clue. The queue proposal
 * below asks for an ordinary checked discovery with the compiler's bounded
 * failback—not a test-only mechanics object or a hand-built queue.
 */
function checkedDiscoveryPdf(title: string): Uint8Array {
  return structuredPdfBytes([
    { text: title, size: 22, x: 72, y: 742 },
    { text: "ENTRY:", size: 18, x: 72, y: 690 },
    { text: "▶ Evidence: The drawer is empty. A close search reveals a hidden mark.", size: 12, x: 72, y: 664 },
    { text: "EXIT:", size: 18, x: 72, y: 610 },
    { text: "ENDING:", size: 18, x: 72, y: 560 },
  ]);
}

const checkedDiscoveryDocuments: readonly TwoModuleHttpCampaignHostDocument[] = [
  { id: "fuzu", moduleId: "host-checked-fuzu", path: "memory://host-checked-fuzu.pdf" },
  { id: "barn", moduleId: "host-checked-barn", path: "memory://host-checked-barn.pdf" },
];

const checkedDiscoverySources: ReadonlyMap<string, Uint8Array> = new Map([
  ["memory://host-checked-fuzu.pdf", checkedDiscoveryPdf("THE CHECKED ARCHIVE")],
  ["memory://host-checked-barn.pdf", checkedDiscoveryPdf("THE CHECKED FARM")],
]);

/** Fits the fixed live pilot's two mechanics chunks before one selector call. */
function livePublicationPdf(tag: string): Uint8Array {
  const prepared = structuredPdfBytes([
    { text: "ENTRY:", size: 18, x: 72, y: 690 },
    { text: "ENDING:", size: 18, x: 72, y: 630 },
  ]);
  // Different authorized bytes without adding a third source heading.
  return new Uint8Array([...prepared, ...new TextEncoder().encode(`\n% ${tag}\n`)]);
}

const livePublicationDocuments: readonly TwoModuleHttpCampaignHostDocument[] = [
  { id: "fuzu", moduleId: "host-live-publication-fuzu", path: "memory://host-live-publication-fuzu.pdf" },
  { id: "barn", moduleId: "host-live-publication-barn", path: "memory://host-live-publication-barn.pdf" },
];

const livePublicationSources: ReadonlyMap<string, Uint8Array> = new Map([
  ["memory://host-live-publication-fuzu.pdf", livePublicationPdf("host-live-fuzu")],
  ["memory://host-live-publication-barn.pdf", livePublicationPdf("host-live-barn")],
]);

/**
 * This remains within smoke mode's two mechanics chunks per document. Its
 * terminal evidence is scoped by EXIT, unlike the compact heading-only pair.
 * The latter remains a no-progress negative.
 */
function liveForwardingPdf(tag: string): Uint8Array {
  const prepared = structuredPdfBytes([
    { text: "ENTRY:", size: 18, x: 72, y: 690 },
    { text: "EXIT:", size: 18, x: 72, y: 630 },
    { text: TERMINAL_EVIDENCE, size: 12, x: 72, y: 604 },
  ]);
  return new Uint8Array([...prepared, ...new TextEncoder().encode(`\n% ${tag}\n`)]);
}

const liveForwardingDocuments: readonly TwoModuleHttpCampaignHostDocument[] = [
  { id: "fuzu", moduleId: "host-live-forwarding-fuzu", path: "memory://host-live-forwarding-fuzu.pdf" },
  { id: "barn", moduleId: "host-live-forwarding-barn", path: "memory://host-live-forwarding-barn.pdf" },
];

const liveForwardingSources: ReadonlyMap<string, Uint8Array> = new Map([
  ["memory://host-live-forwarding-fuzu.pdf", liveForwardingPdf("host-live-forwarding-fuzu")],
  ["memory://host-live-forwarding-barn.pdf", liveForwardingPdf("host-live-forwarding-barn")],
]);

function readDocument(document: TwoModuleHttpCampaignHostDocument): Uint8Array {
  const bytes = sources.get(document.path);
  if (!bytes) throw new Error("missing host test source");
  return new Uint8Array(bytes);
}

function readPublicationDocument(document: TwoModuleHttpCampaignHostDocument): Uint8Array {
  const bytes = publicationSources.get(document.path);
  if (!bytes) throw new Error("missing publication fixture source");
  return new Uint8Array(bytes);
}

function readHeadingOnlyPublicationDocument(document: TwoModuleHttpCampaignHostDocument): Uint8Array {
  const bytes = headingOnlyPublicationSources.get(document.path);
  if (!bytes) throw new Error("missing heading-only publication fixture source");
  return new Uint8Array(bytes);
}

function readCheckedDiscoveryDocument(document: TwoModuleHttpCampaignHostDocument): Uint8Array {
  const bytes = checkedDiscoverySources.get(document.path);
  if (!bytes) throw new Error("missing checked-discovery fixture source");
  return new Uint8Array(bytes);
}

function readLivePublicationDocument(document: TwoModuleHttpCampaignHostDocument): Uint8Array {
  const bytes = livePublicationSources.get(document.path);
  if (!bytes) throw new Error("missing live publication fixture source");
  return new Uint8Array(bytes);
}

function readLiveForwardingDocument(document: TwoModuleHttpCampaignHostDocument): Uint8Array {
  const bytes = liveForwardingSources.get(document.path);
  if (!bytes) throw new Error("missing live forwarding fixture source");
  return new Uint8Array(bytes);
}

function sourceProfileRegistry(entries: readonly {
  moduleId: string;
  documentHash: string;
  allowedWorkIds: readonly string[];
}[]): { registry: CompiledWorldModelBindingRegistry; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "two-module-live-world-profile-"));
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify({
    schemaVersion: "1.1.0",
    kind: "compiled_cthulhu_world_model_policy",
    bindings: [],
    sourceProfiles: entries.map((entry) => ({
      ...entry,
      corpusScopeId: null,
      transferPolicy: "analogy_only",
    })),
  }), "utf8");
  return {
    registry: new CompiledWorldModelBindingRegistry({
      COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: policyPath,
      CTHULHU_DATASET_PATH: CTHULHU_DATASET_ROOT,
    }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface QueueBoundPromptQuestion {
  questionId: string;
  kind: string;
  sourceStatements: Array<{ statementId: string; text: string }>;
  candidateDomains: {
    subjectCandidateId?: string;
    allowedCandidateIds?: string[];
    allowedClueFactAtoms?: Array<{ atomId: string; statementId: string; quote: string }>;
  };
}

interface QueueBoundPromptEnvelope {
  questions: QueueBoundPromptQuestion[];
  candidateCatalog: Array<{ id: string; kind: string; label: string }>;
}

function queueBoundPromptEnvelope(messages: readonly Message[]): QueueBoundPromptEnvelope {
  const content = messages.at(-1)?.content;
  if (typeof content !== "string") throw new Error("benchmark proposal prompt missing text");
  const marker = "REQUEST ENVELOPE:\n";
  const start = content.lastIndexOf(marker);
  if (start < 0) throw new Error("benchmark proposal prompt missing envelope");
  return JSON.parse(content.slice(start + marker.length)) as QueueBoundPromptEnvelope;
}

function isCanonicalEndingSceneLabel(label: string): boolean {
  return label.trim().replace(/:$/, "").toLocaleLowerCase() === "ending";
}

function normalizedSceneLabel(label: string): string {
  return label.trim().replace(/:$/, "").toLocaleLowerCase();
}

function isCanonicalEntrySceneLabel(label: string): boolean {
  return normalizedSceneLabel(label).startsWith("entry");
}

function isCanonicalExitSceneLabel(label: string): boolean {
  return normalizedSceneLabel(label).startsWith("exit");
}

function promptCitation(question: QueueBoundPromptQuestion, claimKey: string, position: "first" | "longest" = "first") {
  const source = position === "first"
    ? question.sourceStatements[0]
    : question.sourceStatements.reduce<QueueBoundPromptQuestion["sourceStatements"][number] | undefined>(
      (selected, candidate) => !selected || candidate.text.length > selected.text.length ? candidate : selected,
      undefined,
    );
  if (!source) throw new Error(`benchmark question lacks source: ${question.questionId}`);
  return { claimKey, statementId: source.statementId, quote: source.text };
}

/**
 * Deterministic benchmark producer: it reads only the current queue envelope
 * and returns source-cited values from that exact domain. It never relies on
 * fixture title strings or fabricated candidate IDs.
 */
interface CheckedDiscoveryReplyOptions {
  /** Omit this to construct a legal checked discovery with no failback. */
  readonly maxFailures?: number;
  /**
   * Keep the marked clue's source-exact shell visible while deliberately
   * making every remaining facet atom source-only. This leaves the ordinary
   * discovery declaration as the sole checked method for the max=10 consumer
   * boundary; it is a legal queue partition, not a hand-built IR.
   */
  readonly sourceOnlyFacetPartition?: boolean;
  /** Keeps a no-failback negative fixture publishable without promoting its clue to core. */
  readonly optionalCoreClue?: boolean;
}

function queueBoundAutoReply(messages: readonly Message[], checked?: CheckedDiscoveryReplyOptions): string {
  const envelope = queueBoundPromptEnvelope(messages);
  const scenes = envelope.candidateCatalog.filter((candidate) => candidate.kind === "scene");
  const entryScene = scenes.find((candidate) => isCanonicalEntrySceneLabel(candidate.label));
  const exitScene = scenes.find((candidate) => isCanonicalExitSceneLabel(candidate.label));
  const proposals = envelope.questions.map((question) => {
    const subject = question.candidateDomains.subjectCandidateId;
    switch (question.kind) {
      case "scene_role": {
        const candidate = subject && envelope.candidateCatalog.find((entry) => entry.id === subject && entry.kind === "scene");
        if (!candidate) throw new Error("scene role lacks its canonical scene candidate");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { role: isCanonicalEndingSceneLabel(candidate.label) ? "ending_section" : "playable_scene" },
          citations: [promptCitation(question, "scene_role")],
        };
      }
      case "entry_scene":
        if (!entryScene) throw new Error("entry-scene question lacks a canonical entry candidate");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { sceneCandidateId: entryScene.id },
          citations: [promptCitation(question, "entry_scene")],
        };
      case "connection_topology": {
        const source = subject && scenes.find((candidate) => candidate.id === subject);
        if (!source) throw new Error("connection topology lacks its canonical scene candidate");
        const nextScene = isCanonicalEntrySceneLabel(source.label)
          ? scenes.find((candidate) => candidate.id !== source.id
            && !isCanonicalExitSceneLabel(candidate.label)
            && !isCanonicalEndingSceneLabel(candidate.label)) ?? exitScene
          : !isCanonicalExitSceneLabel(source.label) && !isCanonicalEndingSceneLabel(source.label)
            ? exitScene
            : undefined;
        const nextSceneId = nextScene?.id;
        const connectionId = `benchmark_connection_${question.questionId.slice(-8)}`;
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { connections: nextSceneId ? [{ toSceneCandidateId: nextSceneId, connectionId }] : [] },
          citations: [promptCitation(question, nextSceneId ? `connection:${connectionId}` : "topology")],
        };
      }
      case "core_clue":
        if (!subject) throw new Error("core clue lacks its candidate domain");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { clueCandidateId: subject, required: checked?.optionalCoreClue !== true },
          citations: [promptCitation(question, "core_clue")],
        };
      case "clue_fact_facets": {
        if (!subject) throw new Error("clue facets lack their candidate domain");
        const atoms = question.candidateDomains.allowedClueFactAtoms;
        if (!atoms?.length) throw new Error("clue facets lack their source atoms");
        const sourceOnlyFacetPartition = checked?.sourceOnlyFacetPartition === true;
        const finding = atoms.at(-1)!;
        const shell = sourceOnlyFacetPartition ? atoms.slice(0, 1) : atoms.slice(0, -1);
        const sourceOnly = sourceOnlyFacetPartition ? atoms.slice(1) : [];
        const findingKey = `bounded_finding_${question.questionId.slice(-8)}`;
        const methodKey = `bounded_search_${question.questionId.slice(-8)}`;
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: {
            shell: shell.map((atom) => ({ atomId: atom.atomId, quote: atom.quote })),
            findings: sourceOnlyFacetPartition ? [] : [{
              findingKey,
              atoms: [{ atomId: finding.atomId, quote: finding.quote }],
              methods: [{
                declarationKey: methodKey,
                action: "search",
                target: "clue",
                ...(checked === undefined ? {} : {
                  check: { kind: "skill", skill: "spot_hidden", difficulty: "regular" },
                  ...(checked.maxFailures === undefined ? {} : { failback: { maxFailures: checked.maxFailures } }),
                }),
              }],
            }],
            sourceOnlyAtomIds: sourceOnly.map((atom) => atom.atomId),
          },
          citations: [
            ...shell.map((atom) => ({ claimKey: `clue_fact_shell:${subject}:${atom.atomId}`, statementId: atom.statementId, quote: atom.quote })),
            ...(sourceOnlyFacetPartition ? sourceOnly.map((atom) => ({ claimKey: `clue_fact_source_only:${subject}:${atom.atomId}`, statementId: atom.statementId, quote: atom.quote })) : [
              { claimKey: `clue_fact_finding:${findingKey}:${finding.atomId}`, statementId: finding.statementId, quote: finding.quote },
              { claimKey: `clue_fact_method:${findingKey}:${methodKey}`, statementId: finding.statementId, quote: finding.quote },
            ]),
          ],
        };
      }
      case "discovery_method": {
        if (!subject) throw new Error("discovery method lacks its clue domain");
        if (!entryScene) throw new Error("discovery method lacks a canonical entry scene");
        const methodId = `benchmark_discovery_${question.questionId.slice(-8)}`;
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: {
            clueCandidateId: subject,
            locationSceneCandidateId: entryScene.id,
            spec: {
              kind: "discovery_method",
              id: methodId,
              clueId: subject,
              action: "search",
              target: "scene",
              targetId: entryScene.id,
              ...(checked === undefined ? {} : {
                check: { kind: "skill", skill: "spot_hidden", difficulty: "regular" },
                ...(checked.maxFailures === undefined ? {} : { failback: { maxFailures: checked.maxFailures, effects: [{ kind: "discover_clue", clueId: subject }] } }),
              }),
              onSuccess: [{ kind: "discover_clue", clueId: subject }],
            },
          },
          citations: [promptCitation(question, `discovery:${methodId}`)],
        };
      }
      case "item_binding":
        if (!subject) throw new Error("item binding lacks its candidate domain");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { itemCandidateId: subject, itemType: null },
          citations: [promptCitation(question, `item_binding:none:${subject}`)],
        };
      case "ending_rule": {
        if (!exitScene) throw new Error("ending rule lacks a canonical exit scene");
        const endingId = "benchmark_exit";
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: {
            declarations: [{
              endingId,
              spec: {
                kind: "ending_rule",
                id: "benchmark_exit_rule",
                priority: 10,
                when: { kind: "scene_visited", sceneId: exitScene.id },
                effects: [{ kind: "end_game", endingId }],
              },
            }],
          },
          // The real ending_rule question carries its terminal paragraph in
          // the source domain. Select that normal source entry, rather than
          // borrowing a scene heading as terminal evidence.
          citations: [promptCitation(question, `ending:${endingId}`, "longest")],
        };
      }
      case "source_fact_disposition": {
        const statementId = question.sourceStatements[0]?.statementId;
        if (!statementId) throw new Error("source fact disposition lacks its statement domain");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { statementId, disposition: "source_only" },
          citations: [promptCitation(question, `source_fact_disposition:${statementId}`)],
        };
      }
      case "npc_binding":
        if (!subject) throw new Error("NPC binding lacks its prose anchor domain");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { proseAnchorId: subject, presentNpcs: [] },
          citations: [promptCitation(question, `npc_binding:none:${subject}`)],
        };
      default:
        throw new Error(`unexpected queue kind for clue-free benchmark PDF: ${question.kind}`);
    }
  });
  return JSON.stringify({ proposals });
}

class QueueBoundBenchmarkLLM implements LLMLike {
  calls = 0;

  async chat(messages: Message[], _options?: ChatOptions): Promise<string> {
    this.calls++;
    return queueBoundAutoReply(messages);
  }
}

/** Uses the same exact queue proposal contract, but requests a bounded checked discovery. */
class QueueBoundCheckedFailbackLLM extends QueueBoundBenchmarkLLM {
  readonly questionKinds = new Set<string>();

  constructor(private readonly checked: CheckedDiscoveryReplyOptions) { super(); }

  override async chat(messages: Message[], _options?: ChatOptions): Promise<string> {
    this.calls++;
    for (const question of queueBoundPromptEnvelope(messages).questions) this.questionKinds.add(question.kind);
    return queueBoundAutoReply(messages, this.checked);
  }
}

async function withForcedFailedSkillChecks<T>(callback: () => Promise<T>): Promise<{ value: T; skillChecks: number }> {
  const originalSkillCheck = CoCEngine.skillCheck;
  let skillChecks = 0;
  // This suite has no concurrent tests. Restore the shared engine seam in
  // finally; a failback must use no CoC skill check at all.
  CoCEngine.skillCheck = ((
    skillValue: number,
    difficulty: "regular" | "hard" | "extreme" = "regular",
    bonusDice = 0,
    penaltyDice = 0,
    luckSpend = 0,
    pushed = false,
  ) => {
    skillChecks++;
    return originalSkillCheck(skillValue, difficulty, bonusDice, penaltyDice, luckSpend, pushed, () => 0.999);
  }) as typeof CoCEngine.skillCheck;
  try {
    return { value: await callback(), skillChecks };
  } finally {
    CoCEngine.skillCheck = originalSkillCheck;
  }
}

type MachineSelectionRequest = {
  schemaVersion: "server-machine-presentation-selector-v1";
  resolvedIdentity: Pick<MachinePresentationSelectionInput["identity"], "moduleId" | "documentHash" | "sourceGraphIdentity" | "preparedQueueHash" | "resolvedQueueHash" | "mechanicsHash">;
  slots: Array<{
    fieldPath: string;
    expectedAudience: "public_on_entry" | "found_clue" | "terminal_only" | "private_context";
    candidates: Array<{ candidateDigest: string }>;
    opaqueCandidateDigest: string | null;
    eligibility: { forbiddenCandidateDigests: string[] };
  }>;
};

type CanonicalMachineSelectionPlans = ReadonlyMap<string, ReadonlyMap<string, string>>;

function machineSelectionPlanKey(identity: MachinePresentationSelectionInput["identity"]): string {
  return [
    identity.moduleId,
    identity.documentHash ?? "",
    identity.sourceGraphIdentity,
    identity.preparedQueueHash,
    identity.resolvedQueueHash,
    identity.mechanicsHash,
  ].join("\u0000");
}

function requiredRecordString(value: unknown, fieldName: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, fieldName)) {
    throw new Error(`expected selector result with ${fieldName}`);
  }
  const field = Reflect.get(value, fieldName);
  if (typeof field !== "string") throw new Error(`selector result ${fieldName} must be a string`);
  return field;
}

/** Replies to both actual proposal envelopes and the host's default selector. */
class QueueBoundDefaultPublicationLLM implements LLMLike {
  calls = 0;
  selectorCalls = 0;
  selectorPlanFailure: "identity" | "missing_source_slot" | "ineligible" | undefined;
  readonly callKinds: Array<"mechanics" | "selector"> = [];

  constructor(private readonly canonicalPlans: CanonicalMachineSelectionPlans = new Map()) {}

  async chat(messages: Message[], _options?: ChatOptions): Promise<string> {
    this.calls++;
    const content = messages.at(-1)?.content;
    if (typeof content !== "string") throw new Error("publication LLM prompt missing text");
    if (content.includes("REQUEST ENVELOPE:\n")) {
      this.callKinds.push("mechanics");
      return queueBoundAutoReply(messages);
    }
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || (parsed as { schemaVersion?: unknown }).schemaVersion !== "server-machine-presentation-selector-v1"
      || typeof (parsed as { resolvedIdentity?: { moduleId?: unknown } }).resolvedIdentity?.moduleId !== "string"
      || !Array.isArray((parsed as { slots?: unknown }).slots)) {
      throw new Error("publication LLM received an unknown prompt shape");
    }
    this.callKinds.push("selector");
    this.selectorCalls++;
    const request = parsed as MachineSelectionRequest;
    const canonicalPlan = this.canonicalPlans.get(machineSelectionPlanKey(request.resolvedIdentity));
    if (this.canonicalPlans.size > 0 && !canonicalPlan) {
      this.selectorPlanFailure = "identity";
      throw new Error("publication selector plan does not recognize the current resolved identity");
    }
    return JSON.stringify({
      selections: request.slots.map((slot) => {
        // The default-selector fake has no private memory between prompts.
        // It may choose only a candidate that this request's host-computed
        // eligibility admits; the real publisher still performs its complete
        // unordered replay validation after all batches.
        const plannedDigest = canonicalPlan?.get(slot.fieldPath);
        const candidate = plannedDigest
          ? slot.candidates.find((entry) => entry.candidateDigest === plannedDigest)
          : slot.candidates.find((entry) => !slot.eligibility.forbiddenCandidateDigests.includes(entry.candidateDigest));
        if (plannedDigest && (!candidate || slot.eligibility.forbiddenCandidateDigests.includes(candidate.candidateDigest))) {
          this.selectorPlanFailure = "ineligible";
          throw new Error(`publication selector plan is not eligible for ${slot.fieldPath}`);
        }
        if (canonicalPlan && slot.candidates.length > 0 && !plannedDigest) {
          this.selectorPlanFailure = "missing_source_slot";
          throw new Error(`publication selector plan omits source candidate for ${slot.fieldPath}`);
        }
        if (candidate) {
          return {
            fieldPath: slot.fieldPath,
            kind: "source_exact",
            candidateDigest: candidate.candidateDigest,
            audience: slot.expectedAudience,
          };
        }
        if (!slot.opaqueCandidateDigest) throw new Error(`publication selector has no canonical candidate for ${slot.fieldPath}`);
        return {
          fieldPath: slot.fieldPath,
          kind: "opaque_unavailable",
          candidateDigest: slot.opaqueCandidateDigest,
          audience: slot.expectedAudience,
        };
      }),
    });
  }
}

function machineScope(fieldPath: string): "public_on_entry" | "found_clue" | "terminal_only" | "private_context" {
  if (fieldPath.startsWith("clues.")) return "found_clue";
  if (/^items\.[^.]+\.name$/.test(fieldPath)) return "public_on_entry";
  if (fieldPath.startsWith("items.")) return "private_context";
  if (fieldPath.startsWith("endings.")) return "terminal_only";
  if (/^npcs\.[^.]+\.description$/.test(fieldPath)) return "private_context";
  return "public_on_entry";
}

/** Reads every bounded machine-publication page and returns only canonical tuples. */
function queueBoundMachinePublisher(
  observeSlots?: (slots: readonly { fieldPath: string; audience: ReturnType<typeof machineScope>; opaqueCandidateDigest: string | null; sourceCandidateCount: number }[]) => void,
  observeSelectionRefusal?: (refusal: { moduleId: string; code: "missing_opaque_candidate" | "no_non_conflicting_source_candidate"; fieldPath: string; candidatePageReadsForField: number }) => void,
  observeCanonicalPlan?: (identity: MachinePresentationSelectionInput["identity"], sourceExactDigests: ReadonlyMap<string, string>) => void,
): MachinePresentationPublisher {
  return {
    servicePrincipalId: "service:offline-benchmark-publisher",
    policyId: "offline-benchmark-presentation-v1",
    select: async (input) => {
      const selections: Array<Record<string, unknown>> = [];
      const scopes: Array<{ fieldPath: string; audience: ReturnType<typeof machineScope> }> = [];
      const declaredSlots: Array<{ fieldPath: string; audience: ReturnType<typeof machineScope>; opaqueCandidateDigest: string | null; sourceCandidateCount: number }> = [];
      for (let offset = 0; ; ) {
        if (input.signal.aborted) throw new Error("benchmark publisher aborted");
        const slots = input.readSlotPage(offset);
        if (slots.status === "refused") throw new Error(slots.message);
        declaredSlots.push(...slots.page.slots.map((slot) => ({
          fieldPath: slot.fieldPath,
          audience: machineScope(slot.fieldPath),
          opaqueCandidateDigest: slot.opaqueCandidateDigest,
          sourceCandidateCount: slot.sourceCandidateCount,
        })));
        if (!slots.page.hasMore) break;
        offset += slots.page.slots.length;
      }
      observeSlots?.(declaredSlots.map((slot) => ({ ...slot })));
      const plannedSlots: Array<{
        slot: (typeof declaredSlots)[number];
        candidates: Array<{
          candidate: {
            kind: "source_exact";
            candidateDigest: string;
            exactText: string;
            quotePolicy: TrustedPresentationQuotePolicy;
          };
          offset: number;
          sourceCandidateOrderHash: string;
        }>;
      }> = [];
      for (const slot of declaredSlots) {
        if (slot.sourceCandidateCount === 0) {
          if (!slot.opaqueCandidateDigest) {
            observeSelectionRefusal?.({
              moduleId: input.identity.moduleId,
              code: "missing_opaque_candidate",
              fieldPath: slot.fieldPath,
              candidatePageReadsForField: 0,
            });
            throw new Error(`missing opaque candidate for ${slot.fieldPath}`);
          }
          plannedSlots.push({ slot, candidates: [] });
          continue;
        }
        // Cursor metadata belongs to a canonical page, not to a candidate.
        // Keep the original candidate instance intact: its non-enumerable
        // host-only range brand is needed for the in-process conflict check.
        const candidates: Array<{
          candidate: {
            kind: "source_exact";
            candidateDigest: string;
            exactText: string;
            quotePolicy: TrustedPresentationQuotePolicy;
          };
          offset: number;
          sourceCandidateOrderHash: string;
        }> = [];
        for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) {
          const page = input.readCandidatePage(slot.fieldPath, offset);
          if (page.status === "refused") throw new Error(page.message);
          candidates.push(...page.page.candidates.map((candidate) => ({
            candidate,
            offset: page.page.offset,
            sourceCandidateOrderHash: page.page.sourceCandidateOrderHash,
          })));
          if (!page.page.hasMore) break;
        }
        plannedSlots.push({ slot, candidates });
      }

      // This local benchmark seam plans over the entire finite canonical
      // candidate set. It deliberately has no audience-priority winner: a
      // complete assignment must leave every public/terminal source range
      // compatible. It is not a claim that a production model has this
      // cross-batch context; the real projection/catalog guard rechecks the
      // resulting unordered tuple independently.
      const selectedSourceExact: Array<{
        audience: ReturnType<typeof machineScope>;
        candidate: (typeof plannedSlots)[number]["candidates"][number]["candidate"];
      }> = [];
      const assigned = new Map<string, (typeof plannedSlots)[number]["candidates"][number]>();
      const sourceExactDigests = new Map<string, string>();
      let searchAttempts = 0;
      const maxSearchAttempts = 50_000;
      const sourcePlans = plannedSlots.filter((plan) => plan.candidates.length > 0)
        .sort((left, right) => left.candidates.length - right.candidates.length || left.slot.fieldPath.localeCompare(right.slot.fieldPath));
      const chooseCompleteAssignment = (index: number): boolean => {
        if (index === sourcePlans.length) return true;
        const plan = sourcePlans[index]!;
        for (const selection of plan.candidates) {
          if (++searchAttempts > maxSearchAttempts) return false;
          const conflicts = selectedSourceExact.some((selected) => (
            (plan.slot.audience === "public_on_entry" && selected.audience === "terminal_only")
            || (plan.slot.audience === "terminal_only" && selected.audience === "public_on_entry")
          ) && machinePresentationSelectionCandidatesShareSourceRange(selection.candidate, selected.candidate));
          if (conflicts) continue;
          selectedSourceExact.push({ audience: plan.slot.audience, candidate: selection.candidate });
          assigned.set(plan.slot.fieldPath, selection);
          if (chooseCompleteAssignment(index + 1)) return true;
          assigned.delete(plan.slot.fieldPath);
          selectedSourceExact.pop();
        }
        return false;
      };
      if (!chooseCompleteAssignment(0)) {
        const refusal = sourcePlans[0];
        if (!refusal) throw new Error("benchmark publisher has no declared selection slots");
        observeSelectionRefusal?.({
          moduleId: input.identity.moduleId,
          code: "no_non_conflicting_source_candidate",
          fieldPath: refusal.slot.fieldPath,
          candidatePageReadsForField: refusal.candidates.length,
        });
        throw new Error("no complete canonical non-conflicting source assignment");
      }
      for (const plan of plannedSlots) {
        const { slot } = plan;
        if (plan.candidates.length === 0) {
          selections.push({ fieldPath: slot.fieldPath, kind: "opaque_unavailable", candidateDigest: slot.opaqueCandidateDigest! });
          scopes.push({ fieldPath: slot.fieldPath, audience: slot.audience });
          continue;
        }
        const selection = assigned.get(slot.fieldPath);
        if (!selection) throw new Error(`benchmark publisher failed to assign ${slot.fieldPath}`);
        selections.push({
          fieldPath: slot.fieldPath,
          kind: "source_exact",
          candidateDigest: selection.candidate.candidateDigest,
          offset: selection.offset,
          sourceCandidateOrderHash: selection.sourceCandidateOrderHash,
        });
        sourceExactDigests.set(slot.fieldPath, selection.candidate.candidateDigest);
        scopes.push({ fieldPath: slot.fieldPath, audience: slot.audience });
      }
      observeCanonicalPlan?.(input.identity, sourceExactDigests);
      return { selections, scopes, requestHash: "a".repeat(64), responseHash: "b".repeat(64) };
    },
  };
}

class InvalidProposalLLM implements LLMLike {
  calls = 0;
  async chat(_messages: Message[], _options?: ChatOptions): Promise<string> {
    this.calls++;
    // The real adapter must reject this and report a real no-progress draft;
    // the host is never allowed to turn it into a mechanically closed module.
    return "{}";
  }
}

function input(llm: LLMLike): Omit<OfflineTwoModuleHttpCampaignHostInput, "observeAdmissionController" | "observeCleanup"> {
  return {
    documents,
    allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
    readDocument,
    llm,
    llmBudget: { maxCalls: 8, timeoutMs: 1_000 },
    policy: {
      policyId: "offline-two-module-http-host-v1",
      rightsStatus: "user_provided" as const,
      allowSourceExactNpcEncounters: true,
      allowedSourceFactMechanicKinds: ["existing_clue_discovery", "prose_fact_finding"] as const,
    },
    producer: { providerFingerprint: "offline-injected", modelFingerprint: "fake-invalid-json" },
    limits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 2, maxRequestChars: 24_000, maxPromptChars: 24_000, maxResponseTokens: 128 },
    maxProposalRounds: 1,
  };
}

function publicationInput(llm: LLMLike) {
  return {
    ...input(llm),
    documents: publicationDocuments,
    allowedDocumentHashes: publicationDocuments.map((document) => sha256(readPublicationDocument(document))),
    readDocument: readPublicationDocument,
    llmBudget: { maxCalls: 48, timeoutMs: 1_000 },
    limits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxPromptChars: 24_000, maxResponseTokens: 256 },
    // The test's model loop remains finite: two bounded adapter rounds, and
    // no more than two HTTP continuations per actual prepared PDF.
    maxProposalRounds: 2,
    maxAutoResolveAttemptsPerModule: 2,
    machinePublisher: queueBoundMachinePublisher(),
  };
}

function headingOnlyPublicationInput(llm: LLMLike) {
  return {
    ...publicationInput(llm),
    allowedDocumentHashes: publicationDocuments.map((document) => sha256(readHeadingOnlyPublicationDocument(document))),
    readDocument: readHeadingOnlyPublicationDocument,
  };
}

async function preparePublicationFixture(
  document: TwoModuleHttpCampaignHostDocument,
  reader: (document: TwoModuleHttpCampaignHostDocument) => Uint8Array,
): Promise<{
  prepared: Awaited<ReturnType<typeof prepareCompiler>> & { status: "prepared" };
  hints: Awaited<ReturnType<typeof requestCompilerHintProposals>>;
}> {
  const prepared = await prepareCompiler({ kind: "pdf_bytes", moduleId: document.moduleId, pdfBytes: reader(document) });
  if (prepared.status !== "prepared") throw new Error(`publication fixture refused: ${prepared.code}`);
  const configured = publicationInput(new QueueBoundBenchmarkLLM());
  const proposals = await requestCompilerHintProposals({
    graph: prepared.artifact.payload.graph,
    queue: prepared.artifact.payload.preparedQueue,
    llm: new QueueBoundBenchmarkLLM(),
    policy: configured.policy,
    producer: configured.producer,
    limits: configured.limits,
  });
  if (proposals.status !== "ok") {
    throw new Error(`publication fixture proposals did not close: ${proposals.status}`);
  }
  if (proposals.unansweredQuestionIds.length !== 0) throw new Error("publication fixture proposals left questions unanswered");
  return { prepared, hints: proposals };
}

async function resolvePublicationFixture(
  document: TwoModuleHttpCampaignHostDocument,
  reader: (document: TwoModuleHttpCampaignHostDocument) => Uint8Array,
): Promise<ResolvedCompilerArtifactPayload> {
  const { prepared, hints } = await preparePublicationFixture(document, reader);
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints.hints);
  if (resolved.status === "refused") throw new Error(`publication fixture resolve refused: ${resolved.code}`);
  const payload = resolved.artifact.payload;
  if (!("mechanicsIR" in payload)) throw new Error("publication fixture resolve returned a non-resolved payload");
  return payload;
}

async function defaultPublicationCanonicalPlans(): Promise<CanonicalMachineSelectionPlans> {
  const plans = new Map<string, ReadonlyMap<string, string>>();
  const result = await runOfflineTwoModuleHttpCampaignHost({
    ...publicationInput(new QueueBoundBenchmarkLLM()),
    machinePublisher: queueBoundMachinePublisher(undefined, undefined, (identity, sourceExactDigests) => {
      plans.set(machineSelectionPlanKey(identity), new Map(sourceExactDigests));
    }),
  });
  if (result.campaign.modules.some((module) => module.status !== "published_consumed") || plans.size !== publicationDocuments.length) {
    throw new Error("canonical publication selector plan could not be captured from the dynamic host route");
  }
  return plans;
}

/** Test-only capture for the exact, finite smoke-policy compiler route. */
async function liveForwardingCanonicalPlans(): Promise<CanonicalMachineSelectionPlans> {
  const plans = new Map<string, ReadonlyMap<string, string>>();
  const result = await runOfflineTwoModuleHttpCampaignHost({
    documents: liveForwardingDocuments,
    allowedDocumentHashes: liveForwardingDocuments.map((document) => sha256(readLiveForwardingDocument(document))),
    readDocument: readLiveForwardingDocument,
    llm: new QueueBoundBenchmarkLLM(),
    llmBudget: {
      maxCalls: LIVE_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches,
      timeoutMs: LIVE_HTTP_CAMPAIGN_LIMITS.perCallTimeoutMs,
    },
    policy: {
      policyId: "live-two-module-http-campaign-v1",
      rightsStatus: "user_provided",
      allowSourceExactNpcEncounters: true,
      allowedSourceFactMechanicKinds: ["existing_clue_discovery", "prose_fact_finding"],
    },
    producer: { providerFingerprint: "live-redacted-v1", modelFingerprint: "configured-redacted-v1" },
    limits: {
      maxQuestionsPerRequest: 3,
      maxRequestsPerRound: LIVE_HTTP_CAMPAIGN_LIMITS.maxRequestsPerRound,
      maxRequestChars: 24_000,
      maxPromptChars: 24_000,
      maxResponseTokens: LIVE_HTTP_CAMPAIGN_LIMITS.maxTokens,
    },
    maxProposalRounds: LIVE_HTTP_CAMPAIGN_LIMITS.maxProposalRounds,
    maxAutoResolveAttemptsPerModule: LIVE_HTTP_CAMPAIGN_LIMITS.maxAutoResolveAttemptsPerModule,
    machinePublisher: queueBoundMachinePublisher(undefined, undefined, (identity, sourceExactDigests) => {
      plans.set(machineSelectionPlanKey(identity), new Map(sourceExactDigests));
    }),
  });
  if (result.campaign.modules.some((module) => module.status !== "published_consumed")
    || plans.size !== liveForwardingDocuments.length) {
    throw new Error("canonical live forwarding selector plan could not be captured from the bounded smoke route");
  }
  return plans;
}

function endingConditionsFieldPath(payload: ResolvedCompilerArtifactPayload): string {
  const ending = payload.mechanicsIR.endings[0];
  const effect = ending?.effects.find((candidate) => candidate.kind === "end_game");
  if (!effect || effect.kind !== "end_game") throw new Error("publication fixture lacks a terminal ending effect");
  return `endings.${effect.endingId}.conditions.0`;
}

/** Deliberately omits a manually supplied publisher: only the host flag may publish. */
function defaultPublicationInput(llm: LLMLike) {
  const { machinePublisher: _machinePublisher, ...rest } = publicationInput(llm);
  return { ...rest, machinePublicationEnabled: true };
}

function legacyPublicationInput(llm: LLMLike) {
  const { machinePublisher: _machinePublisher, ...rest } = publicationInput(llm);
  return rest;
}

function checkedDiscoveryInput(llm: LLMLike) {
  return {
    ...publicationInput(llm),
    documents: checkedDiscoveryDocuments,
    allowedDocumentHashes: checkedDiscoveryDocuments.map((document) => sha256(readCheckedDiscoveryDocument(document))),
    readDocument: readCheckedDiscoveryDocument,
  };
}

function publicationWorldModelResolver(
  bindings: Map<string, CompiledCthulhuWorldModelBinding>,
): CompiledWorldModelBindingResolver {
  const workByModule = new Map([
    ["host-publication-fuzu", "the_call_of_cthulhu" as const],
    ["host-publication-barn", "the_dunwich_horror" as const],
  ]);
  return (identity) => {
    const workId = workByModule.get(identity.moduleId);
    if (!workId) return undefined;
    const binding = createCompiledCthulhuWorldModelBinding({
      moduleId: identity.moduleId,
      artifactHash: identity.artifactHash,
      datasetRoot: CTHULHU_DATASET_ROOT,
      allowedWorkIds: [workId],
      transferPolicy: "analogy_only",
    });
    bindings.set(identity.moduleId, binding);
    return binding;
  };
}

class ReleasableIgnoringAbortLLM implements LLMLike {
  calls = 0;
  private readonly resolvers: Array<(value: string) => void> = [];

  chat(_messages: Message[], _options?: ChatOptions): Promise<string> {
    this.calls++;
    return new Promise<string>((resolve) => this.resolvers.push(resolve));
  }

  release(): void {
    for (const resolve of this.resolvers.splice(0)) resolve("{}");
  }
}

function isOwnedHostTemporaryRoot(root: string): boolean {
  try {
    const canonicalRoot = realpathSync(root);
    return dirname(canonicalRoot) === realpathSync(resolve(tmpdir()))
      && basename(canonicalRoot).startsWith("aitrpg-two-module-http-campaign-host-");
  } catch {
    return false;
  }
}

describe("two-module HTTP campaign host", () => {
  test("uses a distinct structured PDF fixture whose real prepare result exposes a candidate graph", async () => {
    for (const document of publicationDocuments) {
      const prepared = await prepareCompiler({ kind: "pdf_bytes", moduleId: document.moduleId, pdfBytes: readPublicationDocument(document) });
      if (prepared.status === "refused") throw new Error(`publication PDF refused: ${prepared.code}`);
      const draft = prepared.artifact.payload.draft;
      // A core clue is not required for this smallest playable fixture. The
      // later machine selection must consume exactly the queue that this
      // source creates rather than manufacturing an extra marked-item domain.
      if (draft.sceneCandidates.length < 3) {
        throw new Error(JSON.stringify({
          module: document.moduleId,
          scenes: draft.sceneCandidates.map((candidate) => candidate.displayName),
          clues: draft.clueCandidates.map((candidate) => candidate.displayName),
          questions: prepared.questions.map((question) => question.kind),
        }));
      }
      expect(prepared.questions.some((question) => question.kind === "ending_rule")).toBeTrue();
    }
  }, 15_000);

  test("keeps a heading-only terminal citation reviewable while a real terminal paragraph stays source-bound", async () => {
    const sourced = await resolvePublicationFixture(publicationDocuments[0]!, readPublicationDocument);
    const headingOnly = await resolvePublicationFixture(publicationDocuments[0]!, readHeadingOnlyPublicationDocument);
    const sourcedFieldPath = endingConditionsFieldPath(sourced);
    const headingOnlyFieldPath = endingConditionsFieldPath(headingOnly);
    expect(sourcedFieldPath).toBe(headingOnlyFieldPath);

    const sourcedEnding = sourced.mechanicsIR.endings[0];
    if (!sourcedEnding) throw new Error("publication fixture lacks an ending rule");
    const sourceStatementIds = new Set(sourced.acceptedInterpretations
      .filter((interpretation) => sourcedEnding.sourceInterpretationIds.includes(interpretation.id))
      .flatMap((interpretation) => interpretation.sourceStatementIds));
    const terminalParagraph = sourced.graph.statements.find((statement) => sourceStatementIds.has(statement.id) && statement.kind === "paragraph");
    if (!terminalParagraph) throw new Error("ending interpretation lacks a source-scoped paragraph");

    const sourcedManual = buildTrustedPresentationReviewCandidatePage(sourced, sourcedFieldPath, 0);
    const sourcedMachine = buildTrustedPresentationSelectionCandidatePage(sourced, sourcedFieldPath, 0);
    const headingManual = buildTrustedPresentationReviewCandidatePage(headingOnly, headingOnlyFieldPath, 0);
    const headingMachine = buildTrustedPresentationSelectionCandidatePage(headingOnly, headingOnlyFieldPath, 0);
    if (sourcedManual.status === "refused" || sourcedMachine.status === "refused" || headingManual.status === "refused" || headingMachine.status === "refused") {
      throw new Error("publication fixture candidate page was refused");
    }
    expect(sourcedManual.page.candidates.some((candidate) => candidate.exactText === terminalParagraph.text)).toBe(true);
    expect(sourcedMachine.page.candidates.some((candidate) => candidate.exactText === terminalParagraph.text)).toBe(true);
    expect(headingManual.page.candidates.length).toBeGreaterThan(0);
    expect(headingMachine.page.candidates).toHaveLength(1);
  }, 30_000);

  test("classifies every chunked Barn scene role by its subject label instead of the current catalog tail", async () => {
    const prepared = await prepareCompiler({
      kind: "pdf_bytes",
      moduleId: publicationDocuments[1]!.moduleId,
      pdfBytes: readPublicationDocument(publicationDocuments[1]!),
    });
    if (prepared.status === "refused") throw new Error(`Barn publication PDF refused: ${prepared.code}`);
    const sceneRoleQuestions = prepared.artifact.payload.preparedQueue.questions.filter((question) => question.kind === "scene_role");
    expect(sceneRoleQuestions.length).toBeGreaterThan(1);
    const observedSceneRoles: Array<{ subjectId: string; subjectLabel: string; role: unknown }> = [];
    const llm: LLMLike = {
      chat: async (messages) => {
        const envelope = queueBoundPromptEnvelope(messages);
        const response = JSON.parse(queueBoundAutoReply(messages)) as {
          proposals?: Array<{ questionId?: unknown; value?: { role?: unknown } }>;
        };
        for (const question of envelope.questions) {
          if (question.kind !== "scene_role") continue;
          const subjectId = question.candidateDomains.subjectCandidateId;
          const subject = subjectId && envelope.candidateCatalog.find((candidate) => candidate.id === subjectId);
          const proposal = response.proposals?.find((candidate) => candidate.questionId === question.questionId);
          if (!subjectId || !subject || !proposal) throw new Error("Barn scene-role chunk lacks its canonical subject");
          observedSceneRoles.push({ subjectId, subjectLabel: subject.label, role: proposal.value?.role });
        }
        return JSON.stringify(response);
      },
    };
    const configured = publicationInput(llm);
    const proposals = await requestCompilerHintProposals({
      graph: prepared.artifact.payload.graph,
      // Keep the exact queue questions and candidate graph the real PDF
      // prepared; this focused adapter run merely isolates its scene-role
      // chunks so an unrelated singleton question cannot stop observation
      // before the role producer receives any of them.
      queue: withQueueHash({ ...prepared.artifact.payload.preparedQueue, questions: sceneRoleQuestions }),
      llm,
      policy: configured.policy,
      producer: configured.producer,
      limits: { ...configured.limits, maxQuestionsPerRequest: 1 },
    });
    expect(observedSceneRoles.length).toBeGreaterThan(1);
    for (const observed of observedSceneRoles) {
      expect(observed.role).toBe(
        isCanonicalEndingSceneLabel(observed.subjectLabel)
          ? "ending_section"
          : "playable_scene",
      );
    }
    expect(proposals.status).toBe("ok");
  }, 30_000);

  test("answers an actual singleton source-fact disposition without requiring an unrelated entry scene", async () => {
    const prepared = await prepareCompiler({
      kind: "pdf_bytes",
      moduleId: publicationDocuments[1]!.moduleId,
      pdfBytes: readPublicationDocument(publicationDocuments[1]!),
    });
    if (prepared.status !== "prepared") throw new Error(`Barn publication PDF refused: ${prepared.code}`);
    const disposition = prepared.artifact.payload.preparedQueue.questions.find((question) => question.kind === "source_fact_disposition");
    if (!disposition) throw new Error("Barn publication queue lacks an actual source-fact disposition");
    const envelopes: QueueBoundPromptEnvelope[] = [];
    const configured = publicationInput(new QueueBoundBenchmarkLLM());
    const proposals = await requestCompilerHintProposals({
      graph: prepared.artifact.payload.graph,
      queue: withQueueHash({ ...prepared.artifact.payload.preparedQueue, questions: [disposition] }),
      llm: {
        chat: async (messages) => {
          envelopes.push(queueBoundPromptEnvelope(messages));
          return queueBoundAutoReply(messages);
        },
      },
      policy: configured.policy,
      producer: configured.producer,
      limits: { ...configured.limits, maxQuestionsPerRequest: 1 },
    });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.questions.map((question) => question.kind)).toEqual(["source_fact_disposition"]);
    expect(envelopes[0]!.candidateCatalog.some((candidate) => isCanonicalEntrySceneLabel(candidate.label))).toBe(false);
    expect(proposals.status).toBe("ok");
  }, 30_000);

  test("binds Barn's actual terminal paragraph through its ending question and accepted interpretation", async () => {
    const { prepared, hints } = await preparePublicationFixture(publicationDocuments[1]!, readPublicationDocument);
    const draft = resolveDraftModule(
      prepared.artifact.payload.graph,
      prepared.artifact.payload.draft,
      prepared.artifact.payload.preparedQueue,
      hints.hints,
    );
    const endingScene = prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.trim().replace(/:$/, "").toLocaleLowerCase() === "ending");
    if (!endingScene) throw new Error("Barn publication fixture lacks the canonical ENDING heading");
    const terminalParagraphId = prepared.artifact.payload.graph.relations
      .find((relation) => relation.kind === "heading_scopes" && relation.from === endingScene.headingStatementId)?.to;
    const terminalParagraph = terminalParagraphId && prepared.artifact.payload.graph.statements
      .find((statement) => statement.id === terminalParagraphId && statement.kind === "paragraph");
    if (!terminalParagraph) throw new Error("Barn publication fixture lacks a paragraph scoped by canonical ENDING");
    const endingQuestion = draft.resolvedQueue.questions.find((question) => question.kind === "ending_rule");
    if (!endingQuestion) throw new Error("Barn resolved queue lacks an ending question");
    const interpretation = draft.acceptedInterpretations.find((candidate) => candidate.claim.value?.kind === "ending_rule");
    if (!interpretation) throw new Error("Barn ending lacks its accepted interpretation");
    if (!endingQuestion.sourceStatementIds.includes(terminalParagraph.id)
      || !interpretation.sourceStatementIds.includes(terminalParagraph.id)) {
      const statementScope = (statementId: string) => {
        const statement = prepared.artifact.payload.graph.statements.find((candidate) => candidate.id === statementId);
        return {
          id: statementId,
          kind: statement?.kind ?? null,
          parentStatementId: statement?.parentStatementId ?? null,
          scopedByHeadingStatementIds: prepared.artifact.payload.graph.relations
            .filter((relation) => relation.kind === "heading_scopes" && relation.to === statementId)
            .map((relation) => relation.from),
        };
      };
      throw new Error(JSON.stringify({
        stage: !endingQuestion.sourceStatementIds.includes(terminalParagraph.id) ? "ending_question_source_domain" : "accepted_ending_interpretation",
        terminalParagraph: statementScope(terminalParagraph.id),
        endingQuestionSourceStatementIds: endingQuestion.sourceStatementIds,
        endingInterpretationSourceStatementIds: interpretation.sourceStatementIds,
        endingQuestionStatements: endingQuestion.sourceStatementIds.map(statementScope),
        sceneHeadings: prepared.artifact.payload.draft.sceneCandidates.map((scene) => ({
          id: scene.id,
          label: scene.displayName,
          headingStatementId: scene.headingStatementId,
        })),
      }));
    }
    // This direct helper deliberately stops before the host's continuation
    // loop. It proves only the source-domain chain, not the live workflow's
    // dynamically answered queue/readiness or publication outcome.
    expect(interpretation.sourceStatementIds).toContain(terminalParagraph.id);
  }, 30_000);

  test("rejects a same-batch public module and terminal choice that overlap in an actual resolved source range", async () => {
    const payload = await resolvePublicationFixture(publicationDocuments[0]!, readPublicationDocument);
    type ActualSelectionSlot = Extract<ReturnType<typeof buildTrustedPresentationSelectionSlotPage>, { status: "selection_slot_paged" }>["page"]["slots"][number];
    const slots = new Map<string, ActualSelectionSlot>();
    for (let offset = 0; ; ) {
      const page = buildTrustedPresentationSelectionSlotPage(payload, offset);
      if (page.status === "refused") throw new Error(page.message);
      for (const slot of page.page.slots) slots.set(slot.fieldPath, slot);
      if (!page.page.hasMore) break;
      offset += page.page.slots.length;
    }
    type ActualCandidate = {
      readonly fieldPath: string;
      readonly candidateDigest: string;
      readonly offset: number;
      readonly sourceCandidateOrderHash: string;
      readonly statementId: string;
      readonly quote: string;
    };
    const candidates = (fieldPath: string): ActualCandidate[] => {
      const values: ActualCandidate[] = [];
      for (let offset = 0; ; ) {
        const selection = buildTrustedPresentationSelectionCandidatePage(payload, fieldPath, offset);
        const review = buildTrustedPresentationReviewCandidatePage(payload, fieldPath, offset);
        if (selection.status === "refused" || review.status === "refused") throw new Error(`actual candidate page was refused: ${fieldPath}`);
        if (selection.page.candidates.length !== review.page.candidates.length) throw new Error(`actual candidate pages disagree: ${fieldPath}`);
        for (const [index, candidate] of selection.page.candidates.entries()) {
          const canonical = review.page.candidates[index]?.binding;
          if (!canonical) throw new Error(`actual candidate is missing canonical binding: ${fieldPath}`);
          values.push({
            fieldPath,
            candidateDigest: candidate.candidateDigest,
            offset: selection.page.offset,
            sourceCandidateOrderHash: selection.page.sourceCandidateOrderHash,
            statementId: canonical.statementId,
            quote: canonical.quote,
          });
        }
        if (!selection.page.hasMore) break;
        offset += selection.page.candidates.length;
      }
      return values;
    };
    const source = (statementId: string) => payload.graph.statements.find((statement) => statement.id === statementId)?.text;
    const overlaps = (statement: string, left: string, right: string): boolean => {
      const ranges = (quote: string): Array<readonly [number, number]> => {
        const values: Array<readonly [number, number]> = [];
        for (let start = 0; ; start++) {
          const index = statement.indexOf(quote, start);
          if (index < 0) return values;
          values.push([index, index + quote.length]);
          start = index;
        }
      };
      return ranges(left).some(([leftStart, leftEnd]) => ranges(right).some(([rightStart, rightEnd]) => leftStart < rightEnd && rightStart < leftEnd));
    };
    const publicFields = [...slots.values()]
      .filter((slot) => /^module\.(title|version|era|summary|playerCount|expectedDuration)$/.test(slot.fieldPath) && slot.sourceCandidateCount > 0)
      .map((slot) => slot.fieldPath);
    const terminalFields = [...slots.values()]
      .filter((slot) => /^endings\.[^.]+\.(name|description|conditions\.0)$/.test(slot.fieldPath) && slot.sourceCandidateCount > 0)
      .map((slot) => slot.fieldPath);
    let conflict: { public: ActualCandidate; terminal: ActualCandidate } | undefined;
    for (const publicField of publicFields) {
      for (const terminalField of terminalFields) {
        for (const publicCandidate of candidates(publicField)) {
          for (const terminalCandidate of candidates(terminalField)) {
            const statement = publicCandidate.statementId === terminalCandidate.statementId
              ? source(publicCandidate.statementId)
              : undefined;
            if (statement && overlaps(statement, publicCandidate.quote, terminalCandidate.quote)) {
              conflict = { public: publicCandidate, terminal: terminalCandidate };
              break;
            }
          }
          if (conflict) break;
        }
        if (conflict) break;
      }
      if (conflict) break;
    }
    if (!conflict) throw new Error("actual resolved publication fixture lacks a public-module/terminal source-range conflict");
    const pair = [conflict.public, conflict.terminal];
    const input: MachinePresentationSelectionInput = {
      identity: payload.identity,
      readSlotPage: (offset) => offset === 0
        ? {
            status: "selection_slot_paged",
            page: { slots: pair.map((candidate) => slots.get(candidate.fieldPath)!), hasMore: false },
            fieldPathOrderHash: sha256(pair.map((candidate) => candidate.fieldPath).sort().join("\n")),
          }
        : { status: "refused", code: "PRESENTATION_METADATA_INVALID", message: "unexpected actual slot offset" },
      readCandidatePage: (fieldPath, offset) => buildTrustedPresentationSelectionCandidatePage(payload, fieldPath, offset),
      signal: new AbortController().signal,
    };
    const replyFor = (chosen: readonly ActualCandidate[], calls: { value: number }): LLMLike => ({
      chat: async (messages) => {
        calls.value++;
        const request = JSON.parse(messages.at(-1)?.content ?? "{}") as {
          slots?: Array<{ fieldPath: string; expectedAudience: string }>;
        };
        if (!request.slots) throw new Error("expected actual selector slots");
        const chosenByFieldPath = new Map(chosen.map((candidate) => [candidate.fieldPath, candidate]));
        return JSON.stringify({
          selections: request.slots.map((slot) => {
            const candidate = chosenByFieldPath.get(slot.fieldPath);
            if (!candidate) throw new Error(`missing actual selected candidate: ${slot.fieldPath}`);
            return {
              fieldPath: candidate.fieldPath,
              kind: "source_exact",
              candidateDigest: candidate.candidateDigest,
              audience: slot.expectedAudience,
            };
          }),
        });
      },
    });
    const conflictCalls = { value: 0 };
    let failure: unknown;
    try {
      await createServerMachinePresentationPublisher(replyFor(pair, conflictCalls)).select(input);
    } catch (error) {
      failure = error;
    }
    expect(conflictCalls.value).toBe(1);
    expect(failure).toBeInstanceOf(MachinePresentationPublisherError);
    expect((failure as MachinePresentationPublisherError).code).toBe("selector_response_invalid");

    // The field paths are genuine canonical slots, but the digest is not in
    // either actual page. The selector must not turn an arbitrary hash into
    // a source binding merely because its outer response shape is valid.
    const forgedDigest = "0".repeat(64);
    expect(pair.every((candidate) => candidate.candidateDigest !== forgedDigest)).toBe(true);
    const forgedCalls = { value: 0 };
    let forgedFailure: unknown;
    try {
      await createServerMachinePresentationPublisher({
        chat: async (messages) => {
          forgedCalls.value++;
          const request = JSON.parse(messages.at(-1)?.content ?? "{}") as {
            slots?: Array<{ fieldPath: string; expectedAudience: string }>;
          };
          if (!request.slots) throw new Error("expected actual selector slots for forged digest");
          return JSON.stringify({
            selections: request.slots.map((slot) => ({
              fieldPath: slot.fieldPath,
              kind: "source_exact",
              candidateDigest: forgedDigest,
              audience: slot.expectedAudience,
            })),
          });
        },
      }).select(input);
    } catch (error) {
      forgedFailure = error;
    }
    expect(forgedCalls.value).toBe(1);
    expect(forgedFailure).toBeInstanceOf(MachinePresentationPublisherError);
    expect((forgedFailure as MachinePresentationPublisherError).code).toBe("selector_response_invalid");

    const crossBatchInput: MachinePresentationSelectionInput = {
      ...input,
      readSlotPage: (offset) => {
        const candidate = offset === 0 ? conflict.terminal : offset === 1 ? conflict.public : undefined;
        return candidate
          ? {
              status: "selection_slot_paged" as const,
              page: { slots: [slots.get(candidate.fieldPath)!], hasMore: offset === 0 },
              fieldPathOrderHash: sha256(candidate.fieldPath),
            }
          : { status: "refused" as const, code: "PRESENTATION_METADATA_INVALID", message: "unexpected cross-batch slot offset" };
      },
    };
    const crossBatchCalls = { value: 0 };
    let crossBatchFailure: unknown;
    try {
      await createServerMachinePresentationPublisher(replyFor([conflict.public, conflict.terminal], crossBatchCalls)).select(crossBatchInput);
    } catch (error) {
      crossBatchFailure = error;
    }
    expect(crossBatchCalls.value).toBe(2);
    expect(crossBatchFailure).toBeInstanceOf(MachinePresentationPublisherError);
    expect((crossBatchFailure as MachinePresentationPublisherError).code).toBe("selector_response_invalid");

    const legal = candidates(conflict.public.fieldPath).flatMap((publicCandidate) =>
      candidates(conflict.terminal.fieldPath).flatMap((terminalCandidate) => {
        const statement = publicCandidate.statementId === terminalCandidate.statementId
          ? source(publicCandidate.statementId)
          : undefined;
        return statement && !overlaps(statement, publicCandidate.quote, terminalCandidate.quote)
          ? [{ public: publicCandidate, terminal: terminalCandidate }]
          : statement ? [] : [{ public: publicCandidate, terminal: terminalCandidate }];
      }),
    )[0];
    if (!legal) throw new Error("actual resolved publication fixture lacks a non-overlapping public-module/terminal assignment");
    const legalStatement = legal.public.statementId === legal.terminal.statementId ? source(legal.public.statementId) : undefined;
    expect(legalStatement ? overlaps(legalStatement, legal.public.quote, legal.terminal.quote) : false).toBe(false);
    const legalCalls = { value: 0 };
    const accepted = await createServerMachinePresentationPublisher(replyFor([legal.public, legal.terminal], legalCalls)).select(input);
    expect(legalCalls.value).toBe(1);
    expect(accepted.selections.map((selection) => requiredRecordString(selection, "fieldPath")).sort()).toEqual(pair.map((candidate) => candidate.fieldPath).sort());
  }, 30_000);

  test("publishes heading-only terminal conditions only through their canonical interpretation evidence", async () => {
    const observedSlots: Array<{ fieldPath: string; sourceCandidateCount: number; opaqueCandidateDigest: string | null }> = [];
    const observedRefusals: Array<{ moduleId: string; code: "missing_opaque_candidate" | "no_non_conflicting_source_candidate"; fieldPath: string; candidatePageReadsForField: number }> = [];
    const result = await runOfflineTwoModuleHttpCampaignHost({
      ...headingOnlyPublicationInput(new QueueBoundBenchmarkLLM()),
      machinePublisher: queueBoundMachinePublisher(
        (slots) => observedSlots.push(...slots),
        (refusal) => observedRefusals.push(refusal),
      ),
    });
    for (const document of publicationDocuments) {
      const payload = await resolvePublicationFixture(document, readHeadingOnlyPublicationDocument);
      const fieldPath = endingConditionsFieldPath(payload);
      const endingId = fieldPath.split(".")[1];
      const ending = payload.mechanicsIR.endings.find((candidate) => candidate.effects.some((effect) => effect.kind === "end_game" && effect.endingId === endingId));
      if (!ending) throw new Error(`heading-only fixture lacks ending ${endingId}`);
      const page = buildTrustedPresentationReviewCandidatePage(payload, fieldPath, 0);
      if (page.status === "refused") throw new Error(`heading-only candidate page refused: ${page.code}`);
      expect(page.page.candidates).toHaveLength(1);
      const binding = page.page.candidates[0]?.binding;
      if (!binding) throw new Error("heading-only candidate binding missing");
      const statement = payload.graph.statements.find((candidate) => candidate.id === binding.statementId);
      expect(statement?.kind).toBe("heading");
      const interpretationStatementIds = new Set(payload.acceptedInterpretations
        .filter((interpretation) => ending.sourceInterpretationIds.includes(interpretation.id))
        .flatMap((interpretation) => interpretation.sourceStatementIds));
      expect(interpretationStatementIds.has(binding.statementId)).toBe(true);
    }
    expect(observedSlots.filter((slot) => slot.fieldPath === "endings.benchmark_exit.conditions.0"
      && slot.sourceCandidateCount === 1 && slot.opaqueCandidateDigest === null)).toHaveLength(publicationDocuments.length);
    expect(result.campaign.modules.map((module) => ({ status: module.status, code: module.code }))).toEqual([
      { status: "published_consumed", code: undefined },
      { status: "published_consumed", code: undefined },
    ]);
    expect(observedRefusals).toEqual([]);
    expect(result.host).toMatchObject({ publishedBundleConsumptions: 2, compiledActionWitnesses: 2 });
  }, 30_000);

  test("consumes a pair of machine-published structured-PDF-fixture bundles through the catalog and compiled session route", async () => {
    const llm = new QueueBoundBenchmarkLLM();
    const result = await runOfflineTwoModuleHttpCampaignHost({
      ...publicationInput(llm),
      machinePublisher: queueBoundMachinePublisher(),
    });

    expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
    expect(result.host).toMatchObject({
      publishedBundleConsumptions: 2,
      compiledActionWitnesses: 2,
      publishedWorldModelReceiptWitnesses: 0,
      publishedWorldModelScopeHashes: [],
    });
    expect(llm.calls).toBeGreaterThan(0);
    const report = JSON.stringify(result);
    for (const forbidden of ["THE BRASS ARCHIVE", "THE LONELY FARM", "ENTRY HALL", "service:offline-benchmark-publisher", "bundleId", "reviewId"])
      expect(report).not.toContain(forbidden);
  }, 30_000);

  test("recovers a real source-bound checked discovery through its declared failback after the first actual HTTP action fails", async () => {
    const llm = new QueueBoundCheckedFailbackLLM({ maxFailures: 1 });
    const { value: result, skillChecks } = await withForcedFailedSkillChecks(() => runOfflineTwoModuleHttpCampaignHost(checkedDiscoveryInput(llm)));

    expect([...llm.questionKinds]).toEqual(expect.arrayContaining(["clue_fact_facets", "discovery_method"]));
    expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
    expect(result.host).toMatchObject({ publishedBundleConsumptions: 2, compiledActionWitnesses: 2 });
    // One forced failed skill check per module; the durable failback grants
    // the source-bound clue without a third-party executor or another roll.
    expect(skillChecks).toBe(2);
  }, 30_000);

  for (const maxFailures of [2]) {
    test(`recovers the full declared checked-discovery failure budget before failback (maxFailures=${maxFailures})`, async () => {
    const llm = new QueueBoundCheckedFailbackLLM({ maxFailures });
      const { value: result, skillChecks } = await withForcedFailedSkillChecks(() => runOfflineTwoModuleHttpCampaignHost(checkedDiscoveryInput(llm)));

      expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
      expect(result.host).toMatchObject({ publishedBundleConsumptions: 2, compiledActionWitnesses: 2 });
      // The final failback for each module has no skill roll of its own.
      expect(skillChecks).toBe(maxFailures * 2);
    }, 60_000);
  }

  test("recovers the maximum legal checked-discovery failure budget through a source-only facet partition", async () => {
    const llm = new QueueBoundCheckedFailbackLLM({ maxFailures: 10, sourceOnlyFacetPartition: true });
    const { value: result, skillChecks } = await withForcedFailedSkillChecks(() => runOfflineTwoModuleHttpCampaignHost(checkedDiscoveryInput(llm)));

    expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
    expect(result.host).toMatchObject({ publishedBundleConsumptions: 2, compiledActionWitnesses: 2 });
    // Each module consumes ten actual failed checks and a deterministic
    // eleventh failback action. No facet finding method remains in this legal
    // source-only partition, so this is the 11-step host boundary itself.
    expect(skillChecks).toBe(20);
  }, 60_000);

  test("fails closed after the first actual checked-discovery failure when a legal optional clue has no failback", async () => {
    const llm = new QueueBoundCheckedFailbackLLM({ sourceOnlyFacetPartition: true, optionalCoreClue: true });
    const { value: result, skillChecks } = await withForcedFailedSkillChecks(() => runOfflineTwoModuleHttpCampaignHost(checkedDiscoveryInput(llm)));

    // The same source-bound queue still reaches durable publication (the EXIT
    // topology closes it), but no declared failback authorizes a second
    // action after the checked discovery fails.
    expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumer_refused", "published_consumer_refused"]);
    expect(result.host).toMatchObject({ publishedBundleConsumptions: 0, compiledActionWitnesses: 0 });
    expect(skillChecks).toBe(2);
  }, 30_000);

  test("uses the host-owned default selector only after explicit machine publication is enabled", async () => {
    const llm = new QueueBoundDefaultPublicationLLM(await defaultPublicationCanonicalPlans());
    const result = await runOfflineTwoModuleHttpCampaignHost(defaultPublicationInput(llm));

    expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
    expect(result.host).toMatchObject({
      publishedBundleConsumptions: 2,
      compiledActionWitnesses: 2,
    });
    expect(llm.callKinds).toContain("mechanics");
    expect(llm.selectorCalls).toBeGreaterThan(0);
    expect(llm.selectorPlanFailure).toBeUndefined();
  }, 30_000);

  test("retains the legacy draft-only result when machine publication is not enabled", async () => {
    const llm = new QueueBoundDefaultPublicationLLM();
    const result = await runOfflineTwoModuleHttpCampaignHost(legacyPublicationInput(llm));

    expect(result.campaign.modules.map((module) => module.status)).toEqual(["mechanics_closed", "mechanics_closed"]);
    expect(result.host).toMatchObject({ publishedBundleConsumptions: 0, compiledActionWitnesses: 0 });
    expect(llm.selectorCalls).toBe(0);
  }, 30_000);

  test("prefers an explicitly supplied publisher over the enabled default selector", async () => {
    const llm = new QueueBoundBenchmarkLLM();
    const result = await runOfflineTwoModuleHttpCampaignHost({
      ...publicationInput(llm),
      machinePublicationEnabled: true,
    });

    expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
    expect(result.host).toMatchObject({ publishedBundleConsumptions: 2, compiledActionWitnesses: 2 });
    expect(llm.calls).toBeGreaterThan(0);
  }, 30_000);

  test("shares the bounded LLM budget with the enabled default selector instead of bypassing it", async () => {
    const baseline = new QueueBoundDefaultPublicationLLM(await defaultPublicationCanonicalPlans());
    await runOfflineTwoModuleHttpCampaignHost(defaultPublicationInput(baseline));
    const mechanicsCallsBeforeFirstSelector = baseline.callKinds.indexOf("selector");
    expect(mechanicsCallsBeforeFirstSelector).toBeGreaterThan(0);

    const exhausted = new QueueBoundDefaultPublicationLLM();
    const result = await runOfflineTwoModuleHttpCampaignHost({
      ...defaultPublicationInput(exhausted),
      // This admits the real mechanics calls that precede the selector but
      // refuses the selector before it can reach the injected upstream LLM.
      llmBudget: { maxCalls: mechanicsCallsBeforeFirstSelector, timeoutMs: 1_000 },
    });

    // `calls` is the injected upstream counter, rather than a host report
    // field. The default selector must therefore add no raw/provider call.
    expect(exhausted.calls).toBe(mechanicsCallsBeforeFirstSelector);
    expect(exhausted.selectorCalls).toBe(0);
    expect(result.host).toMatchObject({
      llmChatCalls: mechanicsCallsBeforeFirstSelector,
      publishedBundleConsumptions: 0,
      compiledActionWitnesses: 0,
    });
    expect(result.campaign.modules[0]?.status).toBe("response_refused");
  }, 30_000);

  test("binds each fresh published structured-fixture artifact to a separate real local corpus scope before consuming its session", async () => {
    const bindings = new Map<string, CompiledCthulhuWorldModelBinding>();
    const originalFetch = globalThis.fetch;
    let openingFetches = 0;
    globalThis.fetch = (async () => {
      openingFetches++;
      throw new Error("world-model context receipt must cancel before any network dispatch");
    }) as unknown as typeof fetch;
    try {
      const result = await runOfflineTwoModuleHttpCampaignHost({
        ...publicationInput(new QueueBoundBenchmarkLLM()),
        resolveCompiledWorldModelBinding: publicationWorldModelResolver(bindings),
        requirePublishedWorldModelBinding: true,
      });

      expect(bindings.size).toBe(2);
      expect(result.host.publishedWorldModelReceiptWitnesses).toBe(2);
      expect(result.host.publishedWorldModelScopeHashes).toEqual([...bindings.values()].map((binding) => binding.scopeHash).sort());
      expect(new Set(result.host.publishedWorldModelScopeHashes).size).toBe(2);
      expect(bindings.get("host-publication-fuzu")?.allowedWorkIds).toEqual(["the_call_of_cthulhu"]);
      expect(bindings.get("host-publication-barn")?.allowedWorkIds).toEqual(["the_dunwich_horror"]);
      for (const module of result.campaign.modules) {
        const binding = bindings.get(module.module === "fuzu" ? "host-publication-fuzu" : "host-publication-barn");
        expect(binding?.artifactHash).toBe(module.identity?.resolvedArtifactHash);
      }
      expect(openingFetches).toBe(0);
      const report = JSON.stringify(result);
      for (const forbidden of [CTHULHU_DATASET_ROOT, "the_call_of_cthulhu", "the_dunwich_horror"])
        expect(report).not.toContain(forbidden);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  test("auto-publishes fresh artifacts through two 1.1 source profiles before consuming their world-bound sessions", async () => {
    const sourceProfiles = sourceProfileRegistry([
      {
        moduleId: publicationDocuments[0]!.moduleId,
        documentHash: sha256(readPublicationDocument(publicationDocuments[0]!)),
        allowedWorkIds: ["the_call_of_cthulhu"],
      },
      {
        moduleId: publicationDocuments[1]!.moduleId,
        documentHash: sha256(readPublicationDocument(publicationDocuments[1]!)),
        allowedWorkIds: ["the_dunwich_horror"],
      },
    ]);
    const resolvedBindings = new Map<string, CompiledCthulhuWorldModelBinding>();
    const llm = new QueueBoundDefaultPublicationLLM(await defaultPublicationCanonicalPlans());
    try {
      const result = await runOfflineTwoModuleHttpCampaignHost({
        ...defaultPublicationInput(llm),
        resolveCompiledWorldModelBinding: (identity) => {
          const binding = sourceProfiles.registry.resolve(identity);
          if (binding) resolvedBindings.set(identity.moduleId, binding);
          return binding;
        },
        requirePublishedWorldModelBinding: true,
      });

      expect(result.campaign.modules.map((module) => ({ status: module.status, code: module.code }))).toEqual([
        { status: "published_consumed", code: undefined },
        { status: "published_consumed", code: undefined },
      ]);
      expect(result.host).toMatchObject({
        publishedBundleConsumptions: 2,
        compiledActionWitnesses: 2,
        publishedWorldModelBoundSessionCreations: 2,
        publishedWorldModelReceiptWitnesses: 2,
      });
      expect(resolvedBindings.get(publicationDocuments[0]!.moduleId)).toMatchObject({
        moduleId: publicationDocuments[0]!.moduleId,
        allowedWorkIds: ["the_call_of_cthulhu"],
      });
      expect(resolvedBindings.get(publicationDocuments[1]!.moduleId)).toMatchObject({
        moduleId: publicationDocuments[1]!.moduleId,
        allowedWorkIds: ["the_dunwich_horror"],
      });
      expect(new Set(result.host.publishedWorldModelScopeHashes).size).toBe(2);
    } finally {
      sourceProfiles.dispose();
    }
  }, 30_000);

  test("refuses unbound published fixture bundles only when the host explicitly requires a world-model receipt", async () => {
    const legacy = await runOfflineTwoModuleHttpCampaignHost(publicationInput(new QueueBoundBenchmarkLLM()));
    expect(legacy.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
    expect(legacy.host).toMatchObject({
      publishedBundleConsumptions: 2,
      compiledActionWitnesses: 2,
      publishedWorldModelReceiptWitnesses: 0,
      publishedWorldModelScopeHashes: [],
    });

    const required = await runOfflineTwoModuleHttpCampaignHost({
      ...publicationInput(new QueueBoundBenchmarkLLM()),
      requirePublishedWorldModelBinding: true,
    });
    // The auto route retains its existing optional binding contract. This
    // host-only required mode rejects the unbound candidate before any
    // session/action consumer can treat that disposable bundle as consumed.
    expect(required.campaign.modules.map((module) => module.status)).toEqual(["published_consumer_refused", "published_consumer_refused"]);
    expect(required.host).toMatchObject({
      publishedBundleConsumptions: 0,
      compiledActionWitnesses: 0,
      publishedWorldModelReceiptWitnesses: 0,
      publishedWorldModelScopeHashes: [],
    });
  }, 30_000);

  test("fails closed when a trusted resolver returns a cross-module or wrong-artifact local binding", async () => {
    for (const invalid of ["module", "artifact"] as const) {
      const resolver: CompiledWorldModelBindingResolver = (identity) => createCompiledCthulhuWorldModelBinding({
        moduleId: invalid === "module" ? `wrong-${identity.moduleId}` : identity.moduleId,
        artifactHash: invalid === "artifact" ? "0".repeat(64) : identity.artifactHash,
        datasetRoot: CTHULHU_DATASET_ROOT,
        allowedWorkIds: ["the_call_of_cthulhu"],
        transferPolicy: "analogy_only",
      });
      const result = await runOfflineTwoModuleHttpCampaignHost({
        ...publicationInput(new QueueBoundBenchmarkLLM()),
        resolveCompiledWorldModelBinding: resolver,
        requirePublishedWorldModelBinding: true,
      });
      expect(result.campaign.modules.map((module) => module.status)).toEqual(["response_refused", "response_refused"]);
      expect(result.host.publishedBundleConsumptions).toBe(0);
      expect(result.host.publishedWorldModelReceiptWitnesses).toBe(0);
      expect(result.host.publishedWorldModelScopeHashes).toEqual([]);
    }
  }, 30_000);

  test("keeps the compact live source fail-closed before publication or world binding", async () => {
    const originalFetch = globalThis.fetch;
    const llm = new QueueBoundDefaultPublicationLLM();
    const testDocuments = livePublicationDocuments;
    const readTestDocument = readLivePublicationDocument;
    const sourceProfiles = sourceProfileRegistry([
      {
        moduleId: testDocuments[0]!.moduleId,
        documentHash: sha256(readTestDocument(testDocuments[0]!)),
        allowedWorkIds: ["the_call_of_cthulhu"],
      },
      {
        moduleId: testDocuments[1]!.moduleId,
        documentHash: sha256(readTestDocument(testDocuments[1]!)),
        allowedWorkIds: ["the_dunwich_horror"],
      },
    ]);
    const resolvedIdentities: Array<{ moduleId: string; documentHash: string | null; artifactHash: string }> = [];
    const observedRegistry = Object.create(sourceProfiles.registry) as CompiledWorldModelBindingRegistry;
    Object.defineProperty(observedRegistry, "resolve", {
      value: (identity: { moduleId: string; documentHash: string | null; artifactHash: string }) => {
        resolvedIdentities.push({ ...identity });
        return sourceProfiles.registry.resolve(identity);
      },
    });
    let fetchDispatches = 0;
    const outbound: RequestInit[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchDispatches++;
      outbound.push({ ...init });
      const body = JSON.parse(String(init?.body)) as { messages?: Message[] };
      if (!Array.isArray(body.messages)) throw new Error("live fixture request lacks messages");
      const content = await llm.chat(body.messages);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents: testDocuments,
        allowedDocumentHashes: testDocuments.map((document) => sha256(readTestDocument(document))),
        readDocument: readTestDocument,
        machinePublicationEnabled: true,
        requirePublishedWorldModelBinding: true,
        worldModelBindingRegistry: observedRegistry,
        config: {
          apiKey: "sk-live-publication-test-key",
          baseUrl: "https://live-publication-test.invalid/v1",
          model: "live-publication-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
      });

      // This source deliberately lacks the evidence required to close an
      // ending rule. It may use bounded fake transport for mechanics, but
      // must not get as far as machine publication or world binding.
      expect(result.campaign.modules.map((module) => module.status)).toEqual(["stopped_no_progress", "stopped_no_progress"]);
      expect(result.host).toMatchObject({
        mode: "live_llm_client",
        externalNetworkRequests: fetchDispatches,
        publishedBundleConsumptions: 0,
        compiledActionWitnesses: 0,
        publishedWorldModelBoundSessionCreations: 0,
        publishedWorldModelReceiptWitnesses: 0,
      });
      expect(fetchDispatches).toBeGreaterThan(0);
      expect(fetchDispatches).toBeLessThanOrEqual(LIVE_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches);
      expect(llm.selectorCalls).toBe(0);
      expect(resolvedIdentities).toEqual([]);
      for (const request of outbound) {
        expect(request.redirect).toBe("error");
        expect(request.signal).toBeDefined();
        const body = JSON.parse(String(request.body)) as { max_tokens?: unknown };
        expect(body.max_tokens).toBeLessThanOrEqual(LIVE_HTTP_CAMPAIGN_LIMITS.maxTokens);
      }
    } finally {
      sourceProfiles.dispose();
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  test("forwards explicit machine-publication consent through the live wrapper for a bounded publishable source", async () => {
    const originalFetch = globalThis.fetch;
    const llm = new QueueBoundDefaultPublicationLLM(await liveForwardingCanonicalPlans());
    const sourceProfiles = sourceProfileRegistry([
      {
        moduleId: liveForwardingDocuments[0]!.moduleId,
        documentHash: sha256(readLiveForwardingDocument(liveForwardingDocuments[0]!)),
        allowedWorkIds: ["the_call_of_cthulhu"],
      },
      {
        moduleId: liveForwardingDocuments[1]!.moduleId,
        documentHash: sha256(readLiveForwardingDocument(liveForwardingDocuments[1]!)),
        allowedWorkIds: ["the_dunwich_horror"],
      },
    ]);
    const resolvedIdentities: Array<{ moduleId: string; documentHash: string | null; artifactHash: string }> = [];
    const observedRegistry = Object.create(sourceProfiles.registry) as CompiledWorldModelBindingRegistry;
    Object.defineProperty(observedRegistry, "resolve", {
      value: (identity: { moduleId: string; documentHash: string | null; artifactHash: string }) => {
        resolvedIdentities.push({ ...identity });
        return sourceProfiles.registry.resolve(identity);
      },
    });
    let fetchDispatches = 0;
    const outbound: RequestInit[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchDispatches++;
      outbound.push({ ...init });
      const body = JSON.parse(String(init?.body)) as { messages?: Message[] };
      if (!Array.isArray(body.messages)) throw new Error("live forwarding request lacks messages");
      const content = await llm.chat(body.messages);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents: liveForwardingDocuments,
        allowedDocumentHashes: liveForwardingDocuments.map((document) => sha256(readLiveForwardingDocument(document))),
        readDocument: readLiveForwardingDocument,
        machinePublicationEnabled: true,
        requirePublishedWorldModelBinding: true,
        worldModelBindingRegistry: observedRegistry,
        config: {
          apiKey: "sk-live-forwarding-test-key",
          baseUrl: "https://live-forwarding-test.invalid/v1",
          model: "live-forwarding-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
      });

      // These local source profiles are host-owned. This validates that the
      // live wrapper forwards both publication consent and the resolver into
      // the same bounded compiler route; it is not an external model claim.
      expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
      expect(result.host).toMatchObject({
        mode: "live_llm_client",
        externalNetworkRequests: fetchDispatches,
        publishedBundleConsumptions: 2,
        compiledActionWitnesses: 2,
        publishedWorldModelBoundSessionCreations: 2,
        publishedWorldModelReceiptWitnesses: 2,
      });
      expect(fetchDispatches).toBeGreaterThan(0);
      expect(fetchDispatches).toBeLessThanOrEqual(LIVE_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches);
      expect(llm.selectorCalls).toBeGreaterThan(0);
      expect(llm.selectorPlanFailure).toBeUndefined();
      const resolvedHashes = result.campaign.modules.map((module) => module.identity?.resolvedArtifactHash);
      expect(resolvedHashes).toHaveLength(2);
      expect(new Set(resolvedHashes).size).toBe(2);
      expect(resolvedIdentities.map((identity) => identity.moduleId).sort()).toEqual(liveForwardingDocuments.map((document) => document.moduleId).sort());
      expect(resolvedIdentities.map((identity) => identity.documentHash).sort()).toEqual(
        liveForwardingDocuments.map((document) => sha256(readLiveForwardingDocument(document))).sort(),
      );
      for (const request of outbound) {
        expect(request.redirect).toBe("error");
        expect(request.signal).toBeDefined();
        const body = JSON.parse(String(request.body)) as { max_tokens?: unknown };
        expect(body.max_tokens).toBeLessThanOrEqual(LIVE_HTTP_CAMPAIGN_LIMITS.maxTokens);
      }
    } finally {
      sourceProfiles.dispose();
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  test("runs the actual handler through a bounded LLMClient fetch gate only after both source hashes authorize it", async () => {
    const originalFetch = globalThis.fetch;
    const outbound: RequestInit[] = [];
    let fetchDispatches = 0;
    let observedAdmission: CompilerAutoAdmissionController | undefined;
    let admissionAcquires = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchDispatches++;
      outbound.push({ ...init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents,
        allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
        readDocument,
        config: {
          apiKey: "sk-live-campaign-test-key",
          baseUrl: "https://live-campaign-test.invalid/v1",
          model: "live-campaign-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
        observeAdmissionController: (controller) => {
          observedAdmission = controller;
          const acquire = controller.acquire.bind(controller);
          controller.acquire = (request) => {
            admissionAcquires++;
            return acquire(request);
          };
        },
      });

      expect(result.campaign.modules.map((module) => module.status)).toEqual(["stopped_no_progress", "stopped_no_progress"]);
      expect(result.host.mode).toBe("live_llm_client");
      expect(result.host.externalNetworkRequests).toBe(fetchDispatches);
      expect(result.host.admissionControllers).toBe(1);
      // Fuzu's one auto round may fan out to its two permitted chunks before
      // the microtask deadline fires; Barn must not gain a later dispatch.
      expect(fetchDispatches).toBe(2);
      expect(result.budget).toMatchObject({
        kind: "script_owned_external_fetch_admission",
        maxExternalFetchDispatches: 8,
        observedExternalFetchDispatches: fetchDispatches,
        maxTokens: 2_400,
        maxAttempts: 1,
        globalAdmissionDeadlineMs: 180_000,
        globalDeadlineStarted: true,
        globalDeadlineReached: false,
        handlerDeadlineRemainsExisting: true,
      });
      expect(outbound).not.toHaveLength(0);
      expect(observedAdmission).toBeDefined();
      expect(admissionAcquires).toBe(2);
      for (const request of outbound) {
        expect(request.method).toBe("POST");
        expect(request.redirect).toBe("error");
        const body = JSON.parse(String(request.body)) as { max_tokens?: unknown };
        expect(body.max_tokens).toBe(2_400);
      }
      const rendered = JSON.stringify(result);
      for (const forbidden of ["sk-live-campaign-test-key", "live-campaign-test.invalid", "live-campaign-test-model", "{}"])
        expect(rendered).not.toContain(forbidden);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refuses an incompletely authorized live pair before creating admission or dispatching a fetch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchDispatches = 0;
    let observedController = false;
    globalThis.fetch = (async () => {
      fetchDispatches++;
      throw new Error("unapproved live input must not reach fetch");
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents,
        allowedDocumentHashes: [sha256(readDocument(documents[0]!))],
        readDocument,
        config: {
          apiKey: "sk-live-campaign-test-key",
          baseUrl: "https://live-campaign-test.invalid/v1",
          model: "live-campaign-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
        observeAdmissionController: () => { observedController = true; },
      });

      expect(result.campaign.modules.map((module) => module.status)).toEqual(["not_authorized", "not_authorized"]);
      expect(result.host).toEqual({
        mode: "live_llm_client",
        llmChatCalls: 0,
        inProcessHttpNetworkRequests: 0,
        externalNetworkRequests: 0,
        admissionControllers: 0,
        publishedBundleConsumptions: 0,
        compiledActionWitnesses: 0,
        publishedWorldModelBoundSessionCreations: 0,
        publishedWorldModelReceiptWitnesses: 0,
        publishedWorldModelScopeHashes: [],
        cleanup: "not_created",
      });
      expect(result.budget.globalDeadlineStarted).toBeFalse();
      expect(result.budget.observedExternalFetchDispatches).toBe(0);
      expect(fetchDispatches).toBe(0);
      expect(observedController).toBeFalse();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires an operator-profiled source binding for both authorized live PDFs before provider dispatch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchDispatches = 0;
    globalThis.fetch = (async () => {
      fetchDispatches++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const sourceProfiles = sourceProfileRegistry([{
      moduleId: livePublicationDocuments[0]!.moduleId,
      documentHash: sha256(readLivePublicationDocument(livePublicationDocuments[0]!)),
      allowedWorkIds: ["the_call_of_cthulhu"],
    }]);
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents: livePublicationDocuments,
        allowedDocumentHashes: livePublicationDocuments.map((document) => sha256(readLivePublicationDocument(document))),
        readDocument: readLivePublicationDocument,
        config: {
          apiKey: "sk-live-world-profile-test-key",
          baseUrl: "https://live-world-profile-test.invalid/v1",
          model: "live-world-profile-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
        requirePublishedWorldModelBinding: true,
        worldModelBindingRegistry: sourceProfiles.registry,
      });

      expect(result.campaign.modules.map((module) => module.status)).toEqual(["not_authorized", "not_authorized"]);
      expect(result.host).toMatchObject({ llmChatCalls: 0, externalNetworkRequests: 0, admissionControllers: 0 });
      expect(fetchDispatches).toBe(0);
    } finally {
      sourceProfiles.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  test("fails closed before provider dispatch when required live world policy is disabled", async () => {
    const originalFetch = globalThis.fetch;
    let fetchDispatches = 0;
    globalThis.fetch = (async () => {
      fetchDispatches++;
      throw new Error("disabled world policy must not reach provider");
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents: livePublicationDocuments,
        allowedDocumentHashes: livePublicationDocuments.map((document) => sha256(readLivePublicationDocument(document))),
        readDocument: readLivePublicationDocument,
        requirePublishedWorldModelBinding: true,
        worldModelBindingRegistry: new CompiledWorldModelBindingRegistry({}),
        config: {
          apiKey: "sk-live-disabled-world-policy-test-key",
          baseUrl: "https://live-disabled-world-policy-test.invalid/v1",
          model: "live-disabled-world-policy-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
      });

      expect(result.campaign.modules.map((module) => module.status)).toEqual(["not_authorized", "not_authorized"]);
      expect(result.host).toMatchObject({ llmChatCalls: 0, externalNetworkRequests: 0, admissionControllers: 0 });
      expect(fetchDispatches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires full-quality world preflight before allocating a live provider dispatch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchDispatches = 0;
    globalThis.fetch = (async () => {
      fetchDispatches++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents,
        allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
        readDocument,
        config: {
          apiKey: "sk-full-quality-world-preflight-test-key",
          baseUrl: "https://full-quality-world-preflight-test.invalid/v1",
          model: "full-quality-world-preflight-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
        fullQuality: { mode: "full_quality" },
      });

      expect(fetchDispatches).toBe(0);
      expect(result.host.externalNetworkRequests).toBe(0);
      expect(result.preflightReason).toBe("world_not_configured");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reserves the explicit full-quality fetch and deadline budget before the first fake provider dispatch", async () => {
    const originalFetch = globalThis.fetch;
    const sourceProfiles = sourceProfileRegistry([
      {
        moduleId: documents[0]!.moduleId,
        documentHash: sha256(readDocument(documents[0]!)),
        allowedWorkIds: ["the_call_of_cthulhu"],
      },
      {
        moduleId: documents[1]!.moduleId,
        documentHash: sha256(readDocument(documents[1]!)),
        allowedWorkIds: ["the_dunwich_horror"],
      },
    ]);
    const dispatched: Array<{ url: string; maxTokens: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens?: unknown };
      dispatched.push({ url: String(input), maxTokens: body.max_tokens });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents,
        allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
        readDocument,
        worldModelBindingRegistry: sourceProfiles.registry,
        config: {
          apiKey: "sk-full-quality-budget-test-key",
          baseUrl: "https://full-quality-budget-test.invalid/v1",
          model: "full-quality-budget-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
        fullQuality: {
          mode: "full_quality",
          playerDelivery: new CompiledPlayerDelivery({
            secret: "a".repeat(43),
            publicOrigin: "https://full-quality-player.example",
          }),
        },
      });

      expect(result.preflightReason).toBe("ready");
      expect(dispatched.length).toBeGreaterThan(0);
      expect(result.budget.maxExternalFetchDispatches).toBe(FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches);
      expect(result.budget.globalAdmissionDeadlineMs).toBe(FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.defaultGlobalAdmissionDeadlineMs);
    } finally {
      sourceProfiles.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  test("forwards an explicit optional live registry without silently making legacy consumption required", async () => {
    const originalFetch = globalThis.fetch;
    const sourceProfiles = sourceProfileRegistry([{
      // Keep the registry enabled while authorizing no document in this live
      // request; optional mode must still permit ordinary consumption.
      moduleId: "host-unbound-optional-world-profile",
      documentHash: sha256(new TextEncoder().encode("host-unbound-optional-world-profile")),
      allowedWorkIds: ["the_call_of_cthulhu"],
    }]);
    const observed: string[] = [];
    const registry = Object.create(sourceProfiles.registry) as CompiledWorldModelBindingRegistry;
    Object.defineProperty(registry, "resolve", {
      value: (identity: { moduleId: string; documentHash: string | null; artifactHash: string }) => {
        observed.push(`${identity.moduleId}\u0000${identity.documentHash}`);
        return sourceProfiles.registry.resolve(identity);
      },
    });
    const llm = new QueueBoundDefaultPublicationLLM(await liveForwardingCanonicalPlans());
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Message[] };
      if (!Array.isArray(body.messages)) throw new Error("live fixture request lacks messages");
      return new Response(JSON.stringify({ choices: [{ message: { content: await llm.chat(body.messages) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents: liveForwardingDocuments,
        allowedDocumentHashes: liveForwardingDocuments.map((document) => sha256(readLiveForwardingDocument(document))),
        readDocument: readLiveForwardingDocument,
        machinePublicationEnabled: true,
        worldModelBindingRegistry: registry,
        config: {
          apiKey: "sk-live-optional-world-profile-test-key",
          baseUrl: "https://live-optional-world-profile-test.invalid/v1",
          model: "live-optional-world-profile-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
      });

      expect(result.campaign.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
      expect(result.host).toMatchObject({
        publishedWorldModelBoundSessionCreations: 0,
        publishedWorldModelReceiptWitnesses: 0,
        publishedBundleConsumptions: 2,
        compiledActionWitnesses: 2,
      });
      expect(llm.selectorCalls).toBe(2);
      expect(llm.selectorPlanFailure).toBeUndefined();
      expect(observed.sort()).toEqual(liveForwardingDocuments.map((document) => `${document.moduleId}\u0000${sha256(readLiveForwardingDocument(document))}`).sort());
    } finally {
      sourceProfiles.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps the global deadline abort wired through a response body after headers, then reports no post-deadline dispatch", async () => {
    const originalFetch = globalThis.fetch;
    let fireDeadline: (() => void) | undefined;
    let scheduledDeadlineMs: number | undefined;
    let fetchDispatches = 0;
    let bodyAbortObserved = false;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchDispatches++;
      queueMicrotask(() => fireDeadline?.());
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const fallback = setTimeout(() => controller.close(), 20);
          init?.signal?.addEventListener("abort", () => {
            bodyAbortObserved = true;
            clearTimeout(fallback);
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents,
        allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
        readDocument,
        config: {
          apiKey: "sk-live-campaign-test-key",
          baseUrl: "https://live-campaign-test.invalid/v1",
          model: "live-campaign-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
        scheduleDeadline: (callback, delayMs) => {
          fireDeadline = callback;
          scheduledDeadlineMs = delayMs;
          return () => { fireDeadline = undefined; };
        },
      });

      expect(bodyAbortObserved).toBeTrue();
      expect(scheduledDeadlineMs).toBe(LIVE_HTTP_CAMPAIGN_LIMITS.globalAdmissionDeadlineMs);
      expect(result.budget.globalDeadlineStarted).toBeTrue();
      expect(result.budget.globalDeadlineReached).toBeTrue();
      expect(result.budget.observedExternalFetchDispatches).toBe(fetchDispatches);
      expect(fetchDispatches).toBeGreaterThan(0);
      expect(fetchDispatches).toBeLessThanOrEqual(LIVE_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches);
      // The existing auto route converts a bounded LLM failure into an
      // unadvanced draft, never a mechanically closed/published result.
      expect(result.campaign.modules.map((module) => module.status)).toEqual(["stopped_no_progress", "stopped_no_progress"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("hard-stops the ninth live fetch dispatch before it reaches the configured upstream", async () => {
    const originalFetch = globalThis.fetch;
    let fetchDispatches = 0;
    let ninthRejected = false;
    globalThis.fetch = (async (_input: string | URL | Request) => {
      fetchDispatches++;
      if (fetchDispatches === 1) {
        for (let index = 0; index < LIVE_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches; index++) {
          try {
            await globalThis.fetch("https://live-campaign-edge.invalid/v1/chat/completions", {
              method: "POST",
              body: JSON.stringify({ max_tokens: LIVE_HTTP_CAMPAIGN_LIMITS.maxTokens }),
            });
          } catch {
            ninthRejected = true;
          }
        }
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents,
        allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
        readDocument,
        config: {
          apiKey: "sk-live-campaign-test-key",
          baseUrl: "https://live-campaign-edge.invalid/v1",
          model: "live-campaign-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
      });

      expect(result.host.externalNetworkRequests).toBe(8);
      expect(fetchDispatches).toBe(8);
      expect(ninthRejected).toBeTrue();
      expect(result.budget.observedExternalFetchDispatches).toBe(8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes maxAttempts: 1 through the actual LLMClient, so an upstream 503 never retries", async () => {
    const originalFetch = globalThis.fetch;
    let fetchDispatches = 0;
    globalThis.fetch = (async () => {
      fetchDispatches++;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    try {
      const result = await runLiveTwoModuleHttpCampaignHost({
        documents,
        allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
        readDocument,
        config: {
          apiKey: "sk-live-campaign-test-key",
          baseUrl: "https://live-campaign-no-retry.invalid/v1",
          model: "live-campaign-test-model",
          maxTokens: 256_000,
          temperature: 0,
        },
      });

      // This minimal source yields one adapter call per module. A default
      // LLMClient retry would double the two 503 dispatches; maxAttempts:1
      // leaves exactly one request per module, with unpublished drafts.
      expect(fetchDispatches).toBe(2);
      expect(result.host.externalNetworkRequests).toBe(2);
      expect(result.campaign.modules.map((module) => module.status)).toEqual(["stopped_no_progress", "stopped_no_progress"]);
      expect(result.campaign.modules.map((module) => module.reportedProposalCalls)).toEqual([1, 1]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps the native transport available to the controlled --live CLI branch", async () => {
    const originalFetch = globalThis.fetch;
    let nativeFetchCalls = 0;
    const output: string[] = [];
    globalThis.fetch = (async () => {
      nativeFetchCalls++;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const exitCode = await runHostCli([
        "--live",
        "--allow-upload-sha256", "a".repeat(64),
        "--allow-upload-sha256", "b".repeat(64),
      ], {
        isLiveDisabled: () => false,
        readConfig: () => ({
          apiKey: "sk-live-cli-test-key",
          baseUrl: "https://live-cli-test.invalid/v1",
          model: "live-cli-test-model",
          maxTokens: 256_000,
          temperature: 0,
        }),
        hasUsableApiKey: () => true,
        runLive: async () => {
          await globalThis.fetch("https://live-cli-test.invalid/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({ max_tokens: LIVE_HTTP_CAMPAIGN_LIMITS.maxTokens }),
          });
          throw new Error("controlled_cli_stop");
        },
        writeStdout: (line) => output.push(line),
      });

      expect(exitCode).toBe(1);
      expect(nativeFetchCalls).toBe(1);
      expect(output).toEqual([JSON.stringify({ schemaVersion: "1.1.0", status: "live_host_failed" })]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("forwards explicit live machine-publication and world-binding consent through the CLI without changing defaults", async () => {
    let forwarded: { machinePublicationEnabled?: boolean; requirePublishedWorldModelBinding?: boolean } | undefined;
    const output: string[] = [];
    const exitCode = await runHostCli([
      "--live",
      "--machine-publication",
      "--require-world-model",
      "--allow-upload-sha256", "a".repeat(64),
      "--allow-upload-sha256", "b".repeat(64),
    ], {
      isLiveDisabled: () => false,
      readConfig: () => ({
        apiKey: "sk-live-cli-world-policy-test-key",
        baseUrl: "https://live-cli-world-policy-test.invalid/v1",
        model: "live-cli-world-policy-test-model",
        maxTokens: 256_000,
        temperature: 0,
      }),
      hasUsableApiKey: () => true,
      runLive: async (input) => {
        forwarded = input;
        throw new Error("controlled_cli_stop");
      },
      writeStdout: (line) => output.push(line),
    });

    expect(exitCode).toBe(1);
    expect(forwarded).toMatchObject({ machinePublicationEnabled: true, requirePublishedWorldModelBinding: true });
    expect(output).toEqual([JSON.stringify({ schemaVersion: "1.1.0", status: "live_host_failed" })]);
  });

  test("rejects live-only publication and world-binding flags in offline CLI mode instead of silently ignoring them", async () => {
    for (const liveOnlyFlag of ["--machine-publication", "--require-world-model"] as const) {
      const output: string[] = [];
      const errors: string[] = [];
      const exitCode = await runHostCli([
        "--offline",
        liveOnlyFlag,
        "--allow-upload-sha256", "a".repeat(64),
        "--allow-upload-sha256", "b".repeat(64),
      ], {
        writeStdout: (line) => output.push(line),
        writeStderr: (line) => errors.push(line),
      });
      expect(exitCode).toBe(2);
      expect(output).toEqual([]);
      expect(errors).toEqual(["usage_invalid"]);
    }
  });

  test("uses the real internal HTTP handler with one rooted admission controller and reports a genuine offline no-progress campaign", async () => {
    const llm = new InvalidProposalLLM();
    const originalFetch = globalThis.fetch;
    let fetchAttempts = 0;
    let observedAdmission: CompilerAutoAdmissionController | undefined;
    let admissionAcquires = 0;
    globalThis.fetch = (() => {
      fetchAttempts++;
      throw new Error("offline host must not call fetch");
    }) as unknown as typeof fetch;
    try {
      const result = await runOfflineTwoModuleHttpCampaignHost({
        ...input(llm),
        observeAdmissionController: (controller) => {
          observedAdmission = controller;
          const acquire = controller.acquire.bind(controller);
          controller.acquire = (request) => {
            admissionAcquires++;
            return acquire(request);
          };
        },
      });
      expect(result.campaign.modules.map((module) => module.status)).toEqual(["stopped_no_progress", "stopped_no_progress"]);
      expect(result.host).toEqual({
        mode: "offline_injected",
        llmChatCalls: llm.calls,
        inProcessHttpNetworkRequests: 0,
        externalNetworkRequests: "not_observed",
        admissionControllers: 1,
        publishedBundleConsumptions: 0,
        compiledActionWitnesses: 0,
        publishedWorldModelBoundSessionCreations: 0,
        publishedWorldModelReceiptWitnesses: 0,
        publishedWorldModelScopeHashes: [],
        cleanup: "removed",
      });
      expect(llm.calls).toBeGreaterThan(0);
      expect(fetchAttempts).toBe(0);
      expect(observedAdmission).toBeDefined();
      expect(admissionAcquires).toBe(2);
      expect(new Set(result.campaign.modules.map((module) => module.identity?.preparedQueueHash)).size).toBe(2);
      const rendered = JSON.stringify(result);
      for (const forbidden of ["memory://", "offline-injected", "fake-invalid-json", "catalog", "continuation", "http://"]) {
        expect(rendered).not.toContain(forbidden);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("checks both document hashes before allocating an internal catalog or invoking the injected model", async () => {
    const llm = new InvalidProposalLLM();
    let observedController = false;
    const result = await runOfflineTwoModuleHttpCampaignHost({
      ...input(llm),
      allowedDocumentHashes: [sha256(readDocument(documents[0]!))],
      observeAdmissionController: () => { observedController = true; },
    });

    expect(result.campaign.modules.map((module) => module.status)).toEqual(["not_authorized", "not_authorized"]);
    expect(result.host).toEqual({
      mode: "offline_injected",
      llmChatCalls: 0,
      inProcessHttpNetworkRequests: 0,
      externalNetworkRequests: "not_observed",
      admissionControllers: 0,
      publishedBundleConsumptions: 0,
      compiledActionWitnesses: 0,
      publishedWorldModelBoundSessionCreations: 0,
      publishedWorldModelReceiptWitnesses: 0,
      publishedWorldModelScopeHashes: [],
      cleanup: "not_created",
    });
    expect(observedController).toBeFalse();
  });

  test("defers cleanup when a timed-out injected chat ignores abort, then removes only its owned root after the controlled drain settles", async () => {
    const llm = new ReleasableIgnoringAbortLLM();
    const cleanupEvents: string[] = [];
    try {
      const result = await runOfflineTwoModuleHttpCampaignHost({
        ...input(llm),
        llmBudget: { maxCalls: 8, timeoutMs: 1 },
        observeCleanup: (cleanup) => cleanupEvents.push(cleanup),
      });

      expect(result.host.cleanup).toBe("cleanup_deferred");
      expect(result.host.llmChatCalls).toBeGreaterThan(0);
      expect(cleanupEvents).toEqual(["cleanup_deferred"]);
      expect(JSON.stringify(result)).not.toContain("aitrpg-two-module-http-campaign-host-");
    } finally {
      llm.release();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(cleanupEvents).toEqual(["cleanup_deferred", "removed"]);
  });

  test("removes its verified temporary root when post-allocation host construction throws", async () => {
    const llm = new InvalidProposalLLM();
    let root: string | undefined;
    let observedOwnedRoot = false;
    const cleanupEvents: string[] = [];
    const controlled = {
      ...input(llm),
      observeAdmissionController: (controller: CompilerAutoAdmissionController) => {
        root = controller.root;
        observedOwnedRoot = isOwnedHostTemporaryRoot(controller.root);
      },
      observeCleanup: (cleanup: "removed" | "cleanup_deferred") => cleanupEvents.push(cleanup),
    } as OfflineTwoModuleHttpCampaignHostInput;
    Object.defineProperty(controlled, "policy", {
      configurable: true,
      enumerable: true,
      get: () => { throw new Error("controlled_post_allocation_failure"); },
    });
    try {
      await expect(runOfflineTwoModuleHttpCampaignHost(controlled)).rejects.toThrow("controlled_post_allocation_failure");
      expect(root).toBeDefined();
      expect(observedOwnedRoot).toBeTrue();
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 0));
      expect(existsSync(root!)).toBeFalse();
      expect(cleanupEvents).toEqual(["removed"]);
    } finally {
      // A red mutation may deliberately leave this known, test-observed root;
      // remove only that exact temporary target before returning control.
      if (root && existsSync(root) && isOwnedHostTemporaryRoot(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});
