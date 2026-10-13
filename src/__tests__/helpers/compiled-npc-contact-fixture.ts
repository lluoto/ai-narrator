/**
 * Source-bound NPC contact fixture shared by facade and host composition
 * tests. It deliberately travels through prepare -> queue -> resolve ->
 * catalog review -> projection -> bundle; callers never receive a forged
 * artifact or a hand-built dialogue clue.
 */
import { join } from "path";
import { expect } from "bun:test";
import { CompilerArtifactCatalog } from "../../compiler/compiler-artifact-catalog";
import {
  buildTrustedPresentationSelectionCandidatePage,
  buildTrustedPresentationSelectionSlotPage,
  projectTrustedResolvedCompilerArtifact,
  rehydrateTrustedPresentationSelections,
  trustedPresentationMachineCoverageIdentity,
  trustedPresentationMachineDecisionIdentity,
  type TrustedPresentationMachinePublication,
} from "../../compiler/compiler-module-data-projection";
import type { ResolvedCompilerArtifactPayload } from "../../compiler/compiler-artifact";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../../compiler/compiler-api";
import {
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  parseCompilerHintValue,
  type CompilerQuestion,
  type CompilerQuestionResolution,
  type ModuleCompileHints,
} from "../../compiler/compiler-question-queue";
import { GameSession } from "../../api/game-session";
import { CompiledSessionSnapshotStore } from "../../api/compiled-session-snapshot";
import { createServerMachinePresentationPublisher } from "../../api/compiler-machine-presentation-publisher";
import type { CompilerRequestAuthenticator } from "../../api/compiled-module-http";
import type { CompiledPlayerDelivery } from "../../api/player-delivery";
import { handleRequest } from "../../api/server";
import { exactReviewBindings } from "./trusted-presentation-review";

export const NPC_CONTACT_PAGES = [
  "Dock:\nCaptain Mira waits beside the launch and says the stone can take you outside.\nArchive:\n\u25B6Dream Stone: The dream stone opens the exit.\nExit:",
] as const;

export const NPC_CONTACT_DIALOGUES = [
  { mechanismId: "ask_mira_about_stone", relationshipQuote: "the stone can take you outside" },
] as const;

export const NPC_CONTACT_MULTI_PAGES = [
  "Dock:\nCaptain Mira says the stone can take you outside.\nCaptain Mira says the launch opens at dawn.\nArchive:\n\u25B6Dream Stone: The dream stone opens the exit.\nExit:",
] as const;

export const NPC_CONTACT_TERMINAL_PAGES = [
  "Dock:\nCaptain Mira says the stone can take you outside, and the launch opens at dawn.\nArchive:\n\u25B6Dream Stone: The dream stone opens the exit.\nExit:\nThe launch leaves the harbor at dawn.\nEnding:\nWhen Mira confirms the launch is open, the journey may end at the dock.",
] as const;

export const NPC_CONTACT_MULTI_DIALOGUES = [
  { mechanismId: "ask_mira_about_z_stone", relationshipQuote: "the stone can take you outside" },
  { mechanismId: "ask_mira_about_alpha_launch", relationshipQuote: "the launch opens at dawn" },
] as const;

export const NPC_CONTACT_TERMINAL_DIALOGUES = [
  { mechanismId: "contact_mira_stone", relationshipQuote: "the stone can take you outside" },
  { mechanismId: "contact_mira_z_launch", relationshipQuote: "the launch opens at dawn" },
] as const;

export type NpcContactFixtureOptions = Readonly<{
  pages?: readonly string[];
  /** A source heading before Dock; NPC bindings remain at their original Dock anchor. */
  entrySceneName?: string;
  /** Original PDF bytes for host-composition tests that require a byte hash. */
  pdfBytes?: Uint8Array;
  dialogues?: readonly { mechanismId: string; relationshipQuote: string }[];
  terminalAfterDialogueIndex?: number;
  /**
   * Test-only browser delivery: creation remains owner-authenticated and
   * deliberately omits the legacy in-process player assignment so callers
   * must claim the returned invitation before using player routes.
   */
  playerDelivery?: CompiledPlayerDelivery;
}>;

function npcContactAnswer(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
  return {
    questionId: question.id,
    kind: question.kind,
    value,
    sourceStatementIds: [...question.sourceStatementIds],
    evidenceRefs: [...question.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "source-bound NPC contact benchmark",
  };
}

function npcContactQuestion(
  prepared: PreparedCompilerApiResult,
  kind: CompilerQuestion["kind"],
  subject?: string,
): CompilerQuestion {
  const question = prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.kind === kind
    && (subject === undefined || candidate.subjectCandidateId === subject));
  if (!question) throw new Error(`contact fixture lacks ${kind}`);
  return question;
}

/** Legal, source-grounded benchmark hints for one current-scene prose talk. */
export function npcContactHints(
  prepared: PreparedCompilerApiResult,
  dialogues: readonly { mechanismId: string; relationshipQuote: string }[] = NPC_CONTACT_DIALOGUES,
  terminalAfterDialogueIndex?: number,
  entrySceneName?: string,
): ModuleCompileHints {
  const { draft, graph, preparedQueue: queue } = prepared.artifact.payload;
  const scene = (name: string) => {
    const candidate = draft.sceneCandidates.find((entry) => entry.displayName.startsWith(name));
    if (!candidate) throw new Error(`contact fixture lacks ${name}`);
    return candidate;
  };
  const dock = scene("Dock");
  const entry = entrySceneName === undefined ? dock : scene(entrySceneName);
  const archive = scene("Archive");
  const exit = scene("Exit");
  const ending = terminalAfterDialogueIndex === undefined ? undefined : scene("Ending");
  const item = draft.itemCandidates[0];
  const clue = draft.clueCandidates[0];
  const anchor = draft.proseNpcAnchors.find((candidate) => candidate.sceneCandidateId === dock.id);
  const paragraph = anchor && graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
  const itemName = item && graph.statements.find((statement) => statement.id === item.nameStatementId);
  if (!item || !clue || !anchor || !paragraph || !itemName) throw new Error("contact fixture lacks exact NPC source candidates");
  const npcQuestion = npcContactQuestion(prepared, "npc_binding", anchor.id);
  const npcValue = {
    proseAnchorId: anchor.id,
    presentNpcs: [{
      nameQuote: "Mira",
      dialogueMethods: dialogues.map(({ mechanismId, relationshipQuote }) => ({
        mechanismId,
        relationshipEvidence: { statementId: paragraph.id, quote: relationshipQuote },
      })),
    }],
  };
  const parsedNpc = parseCompilerHintValue(npcQuestion, npcValue, graph);
  const terminalClueId = terminalAfterDialogueIndex === undefined ? undefined
    : parsedNpc.kind === "npc_binding"
      ? parsedNpc.presentNpcs[0]?.dialogueMethods[terminalAfterDialogueIndex]?.clueId
      : undefined;
  if (terminalAfterDialogueIndex !== undefined && !terminalClueId) throw new Error("contact fixture lacks requested terminal dialogue clue");
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => npcContactAnswer(question, { shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] })),
      ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => npcContactAnswer(question, {
        role: question.subjectCandidateId === ending?.id ? "ending_section" : "playable_scene",
      })),
      npcContactAnswer(npcContactQuestion(prepared, "entry_scene"), { sceneCandidateId: entry.id }),
      ...(entry.id === dock.id ? [] : [npcContactAnswer(npcContactQuestion(prepared, "connection_topology", entry.id), {
        connections: [{ toSceneCandidateId: dock.id, connectionId: "entry_dock" }],
      })]),
      npcContactAnswer(npcContactQuestion(prepared, "connection_topology", dock.id), { connections: [{ toSceneCandidateId: archive.id, connectionId: "dock_archive" }] }),
      npcContactAnswer(npcContactQuestion(prepared, "connection_topology", archive.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "archive_exit" }] }),
      npcContactAnswer(npcContactQuestion(prepared, "connection_topology", exit.id), { connections: [] }),
      ...(ending ? [npcContactAnswer(npcContactQuestion(prepared, "connection_topology", ending.id), { connections: [] })] : []),
      npcContactAnswer(npcContactQuestion(prepared, "core_clue", clue.id), { clueCandidateId: clue.id, required: false }),
      npcContactAnswer(npcContactQuestion(prepared, "item_binding", item.id), {
        itemCandidateId: item.id,
        itemType: "key",
        itemNameEvidence: { statementId: item.nameStatementId, quote: itemName.text },
      }),
      npcContactAnswer(npcContactQuestion(prepared, "discovery_method", clue.id), {
        clueCandidateId: clue.id,
        locationSceneCandidateId: archive.id,
        spec: {
          kind: "discovery_method",
          id: "search_dream_stone",
          clueId: clue.id,
          action: "search",
          target: "item",
          targetId: item.id,
          onSuccess: [{ kind: "discover_clue", clueId: clue.id }, { kind: "acquire_item", itemId: item.id }],
        },
      }),
      npcContactAnswer(npcQuestion, npcValue),
      npcContactAnswer(npcContactQuestion(prepared, "ending_rule"), {
        declarations: [
          { endingId: "escape_with_stone", spec: { kind: "ending_rule", id: "rule_escape_with_stone", priority: 1, when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "item_owned", itemId: item.id }] }, effects: [{ kind: "end_game", endingId: "escape_with_stone" }] } },
          { endingId: "lost_without_stone", spec: { kind: "ending_rule", id: "rule_lost_without_stone", priority: 2, when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "item_owned", itemId: item.id } }] }, effects: [{ kind: "end_game", endingId: "lost_without_stone" }] } },
          ...(terminalClueId === undefined ? [] : [{ endingId: "mira_confirms_launch", spec: { kind: "ending_rule" as const, id: "rule_mira_confirms_launch", priority: 3, when: { kind: "clue_found" as const, clueId: terminalClueId }, effects: [{ kind: "end_game" as const, endingId: "mira_confirms_launch" }] } }]),
        ],
      }),
    ],
  };
}

export function npcContactMachinePublisher() {
  const publicTexts: string[] = [];
  const terminalTexts: string[] = [];
  const overlaps = (left: string, right: string) => left.includes(right) || right.includes(left);
  return createServerMachinePresentationPublisher({
    async chat(messages) {
      const request = JSON.parse(messages[1]?.content ?? "") as {
        schemaVersion?: string;
        slots?: Array<{
          fieldPath: string;
          expectedAudience: "public_on_entry" | "found_clue" | "terminal_only" | "private_context";
          candidates: Array<{ candidateDigest: string; exactText: string }>;
          eligibility: { forbiddenCandidateDigests: readonly string[] };
          opaqueCandidateDigest: string | null;
        }>;
      };
      if (request.schemaVersion !== "server-machine-presentation-selector-v1" || !request.slots) {
        throw new Error("contact fixture machine publisher received an invalid bounded selector request");
      }
      const currentTerminalTexts = request.slots
        .filter((slot) => slot.expectedAudience === "terminal_only")
        .map((slot) => slot.candidates.find((candidate) => !publicTexts.some((text) => overlaps(candidate.exactText, text)))?.exactText)
        .filter((text): text is string => !!text);
      const selections = request.slots.map((slot) => {
        const forbidden = slot.expectedAudience === "terminal_only" ? publicTexts
          : slot.expectedAudience === "public_on_entry" ? [...terminalTexts, ...currentTerminalTexts]
            : [];
        const candidate = slot.candidates.find((entry) => !slot.eligibility.forbiddenCandidateDigests.includes(entry.candidateDigest)
          && !forbidden.some((text) => overlaps(entry.exactText, text))
          && (slot.expectedAudience !== "terminal_only" || !entry.exactText.includes("Captain Mira")));
        if (candidate) return { fieldPath: slot.fieldPath, kind: "source_exact", candidateDigest: candidate.candidateDigest, audience: slot.expectedAudience };
        if (!slot.opaqueCandidateDigest) throw new Error(`contact fixture lacks a canonical selection: ${slot.fieldPath}`);
        return { fieldPath: slot.fieldPath, kind: "opaque_unavailable", candidateDigest: slot.opaqueCandidateDigest, audience: slot.expectedAudience };
      });
      for (const [index, slot] of request.slots.entries()) {
        const selected = selections[index];
        const candidate = selected?.kind === "source_exact"
          ? slot.candidates.find((entry) => entry.candidateDigest === selected.candidateDigest)
          : undefined;
        if (!candidate) continue;
        if (slot.expectedAudience === "public_on_entry") publicTexts.push(candidate.exactText);
        if (slot.expectedAudience === "terminal_only") terminalTexts.push(candidate.exactText);
      }
      return JSON.stringify({ selections });
    },
  });
}

/**
 * Existing facade callers retain the same setup and receive a session only
 * after actual source processing and a catalog-backed source-bound review.
 */
export function createNpcContactSessionFixture(owner: CompilerRequestAuthenticator) {
  return async function createNpcContactSession(
    root: string,
    reviewKind: "machine" | "manual" = "machine",
    options: NpcContactFixtureOptions = {},
  ) {
    const pages = options.pages ?? NPC_CONTACT_PAGES;
    const dialogues = options.dialogues ?? NPC_CONTACT_DIALOGUES;
    const prepared = await prepareCompiler(options.pdfBytes
      ? { kind: "pdf_bytes", moduleId: `npc-contact-${reviewKind}`, pdfBytes: new Uint8Array(options.pdfBytes) }
      : { kind: "synthetic_pages", moduleId: `npc-contact-${reviewKind}`, sourceDescriptor: `npc-contact-${reviewKind}`, pages: [...pages] });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const hints = npcContactHints(prepared, dialogues, options.terminalAfterDialogueIndex, options.entrySceneName);
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    if (options.pdfBytes && typeof payload.identity.documentHash !== "string") {
      throw new Error("contact fixture resolved identity lacks a document hash");
    }
    const proseClue = payload.proseDialogueClues[0];
    if (!proseClue) throw new Error("contact fixture lacks a canonical prose dialogue clue");
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const savedPrepared = catalog.savePrepared(prepared.artifact);
    if (savedPrepared.status !== "ok") throw new Error(savedPrepared.message);

    let bindings = exactReviewBindings(payload);
    let machinePublication: TrustedPresentationMachinePublication | undefined;
    if (reviewKind === "machine") {
      const publisher = npcContactMachinePublisher();
      const selected = await publisher.select({
        identity: resolved.identity,
        signal: new AbortController().signal,
        readSlotPage: (offset) => buildTrustedPresentationSelectionSlotPage(payload, offset),
        readCandidatePage: (fieldPath, offset) => buildTrustedPresentationSelectionCandidatePage(payload, fieldPath, offset),
      });
      const rehydrated = rehydrateTrustedPresentationSelections(payload, selected.selections);
      if (rehydrated.status !== "rehydrated") throw new Error(rehydrated.message);
      bindings = rehydrated.bindings;
      const scopes = selected.scopes as TrustedPresentationMachinePublication["scopes"];
      machinePublication = {
        servicePrincipalId: publisher.servicePrincipalId,
        policyId: publisher.policyId,
        requestHash: selected.requestHash,
        responseHash: selected.responseHash,
        decisionHash: trustedPresentationMachineDecisionIdentity(bindings, scopes),
        coverageHash: trustedPresentationMachineCoverageIdentity(scopes),
        scopes,
      };
    }
    const review = catalog.saveTrustedPresentationReview(
      savedPrepared.value.id,
      prepared.artifact,
      resolved.artifact,
      reviewKind === "machine" ? machinePublication!.servicePrincipalId : "operator:contact-benchmark",
      bindings,
      machinePublication ? { machinePublication } : {},
    );
    if (review.status !== "ok") throw new Error(review.message);
    const loadedReview = catalog.loadTrustedPresentationReview(review.value.id);
    if (loadedReview.status !== "ok") throw new Error(loadedReview.message);
    const projection = projectTrustedResolvedCompilerArtifact(payload, loadedReview.value.review);
    if (projection.status === "refused") throw new Error(projection.message);
    const bundle = catalog.saveBundle(resolved.artifact, projection);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
    const registry = new Map<string, GameSession>();
    const compiledDurableHostCapability = Object.freeze(Object.create(null)) as object;
    const created = await (handleRequest as any)(
      new Request("http://test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId: bundle.value.id, archetype: "investigator", characterName: "Ada" }),
      }),
      catalog,
      snapshots,
      { careerRoot: join(root, "careers") },
      {},
      {},
      owner,
      undefined,
      options.playerDelivery
        ? undefined
        : () => ({ status: "assigned" as const, principal: { role: "player" as const, id: "player:facade-p1" } }),
      options.playerDelivery,
      undefined,
      { registry, compiledDurableHostCapability },
    );
    // Preserve the fixture's original assertion: every caller must observe
    // that the normal catalog-backed compiled-session route admitted it.
    expect(created.status).toBe(201);
    if (created.status !== 201) throw new Error(`contact fixture session creation refused: ${created.status}`);
    const body: unknown = await created.json();
    if (!body || typeof body !== "object" || typeof (body as { sessionId?: unknown }).sessionId !== "string") {
      throw new Error("contact fixture session creation did not return a session ID");
    }
    const playerInvitation = (body as { playerInvitation?: unknown }).playerInvitation;
    if (options.playerDelivery && (!playerInvitation || typeof playerInvitation !== "object"
      || typeof (playerInvitation as { invite?: unknown }).invite !== "string")) {
      throw new Error("contact fixture delivery creation did not return an invitation");
    }
    return {
      root,
      catalog,
      snapshots,
      sessionId: (body as { sessionId: string }).sessionId,
      payload,
      proseClue,
      proseClues: payload.proseDialogueClues,
      machinePublication,
      bindings,
      preparedArtifact: prepared.artifact,
      resolvedArtifact: resolved.artifact,
      ...(typeof payload.identity.documentHash === "string" ? {
        publication: {
          module: "fuzu" as const,
          bundleId: bundle.value.id,
          identity: {
            moduleId: payload.identity.moduleId,
            documentHash: payload.identity.documentHash,
            sourceGraphIdentity: payload.identity.sourceGraphIdentity,
            preparedQueueHash: payload.identity.preparedQueueHash,
            preparedArtifactHash: prepared.artifact.artifactHash,
            resolvedArtifactHash: resolved.artifact.artifactHash,
          },
        },
      } : {}),
      ...(options.playerDelivery ? { playerInvitation: playerInvitation as { invite: string; expiresAt: number; playPath: string } } : {}),
      registry,
      compiledDurableHostCapability,
    };
  };
}
