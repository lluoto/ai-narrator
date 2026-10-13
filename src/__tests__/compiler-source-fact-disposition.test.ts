import { describe, expect, it } from "bun:test";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { restoreCompilerArtifact, sealCompilerArtifact, type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { summarizeCompilerRuntimeQuality } from "../compiler/compiler-runtime-quality";
import { buildResolvedSourceFactDispositionReport } from "../compiler/source-fact-disposition";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import type { MechanicsCandidateSpec } from "../compiler/mechanics-ir";
import type { FactInterpretationCandidate } from "../compiler/source-fact-graph";
import { allShellClueFactFacetResolutions } from "./helpers/clue-fact-facet-hints";

const PAGES = [
  "Entrance:\nCaptain Mira waits beside the locked gate.\n\n- A marginal list note remains unclassified.\n\n▶Gate Key: A corroded key fits the manor lock.\nExit:\nA road home lies beyond the gate.\nRewards:\nSAN +1d6\nCM +2\nCR +3\nEnding:\nLeaving the gate ends the investigation.",
];

// This variant deliberately has no structurally unmodeled list/unknown root.
// It isolates the rule that open semantic slots keep content incomplete even
// when every root already has a non-unmodeled primary disposition.
const ALL_PRIMARY_DISPOSITIONS_PAGES = [
  "Entrance:\nCaptain Mira waits beside the locked gate.\n\n▶Gate Key: A corroded key fits the manor lock.\nExit:\nA road home lies beyond the gate.\nRewards:\nSAN +1d6\nCM +2\nCR +3\nEnding:\nLeaving the gate ends the investigation.",
];

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** The public summary admits only fixed aggregate keys, enum status, and safe counts. */
function expectAggregateOnlyQuality(value: unknown): void {
  const quality = record(value, "quality");
  expect(Object.keys(quality).sort()).toEqual(["closedWorldIssueCounts", "coverage", "sourceRootDisposition"]);

  const source = record(quality.sourceRootDisposition, "source root disposition");
  expect(Object.keys(source).sort()).toEqual([
    "counts",
    "dispositionReadiness",
    "mechanicsCandidateRootCount",
    "openQuestionCount",
    "openRootCount",
    "positiveCoverage",
    "rootStatementCount",
    "unmodeledRootCount",
  ]);
  expect(source.dispositionReadiness === "complete" || source.dispositionReadiness === "incomplete").toBe(true);
  const positive = record(source.positiveCoverage, "positive coverage");
  expect(Object.keys(positive).sort()).toEqual([
    "acceptedBindingRootCount",
    "mechanicsEvidenceRootCount",
    "positiveRootCount",
    "sourceOnlyDecisionRootCount",
    "sourceOnlyOnlyRootCount",
    "uncoveredRootCount",
  ]);
  const sourceCounts = record(source.counts, "source root disposition counts");
  expect(Object.keys(sourceCounts).sort()).toEqual([
    "accepted_binding",
    "draft_candidate_open",
    "explicitly_unbound",
    "mechanics_evidence",
    "unmodeled",
  ]);

  const coverage = record(quality.coverage, "coverage");
  expect(Object.keys(coverage).sort()).toEqual([
    "boundItems",
    "boundNpcAnchors",
    "boundNpcs",
    "boundRewards",
    "clueCandidates",
    "compiledClues",
    "declaredEndings",
    "dialogueMethods",
    "discoveryMethods",
    "encounters",
    "itemCandidates",
    "playableScenes",
    "proseDialogueClues",
    "proseFactFindingClues",
    "proseNpcAnchors",
    "reachableEndings",
    "rewardCandidates",
    "runtimeItems",
    "runtimeRewards",
    "sceneCandidates",
  ]);

  const issueCounts = record(quality.closedWorldIssueCounts, "closed-world issue counts");
  expect(Object.keys(issueCounts).sort()).toEqual([
    "closed_world_deadlock",
    "core_clue_failure_policy_risk",
    "unreachable_core_clue",
    "unreachable_ending",
  ]);

  const leaves: unknown[] = [];
  const visit = (current: unknown): void => {
    if (current && typeof current === "object") {
      expect(Array.isArray(current)).toBe(false);
      for (const nested of Object.values(current as Record<string, unknown>)) visit(nested);
      return;
    }
    leaves.push(current);
  };
  const jsonRoundTrip = JSON.parse(JSON.stringify(quality));
  expect(jsonRoundTrip).toEqual(quality);
  visit(jsonRoundTrip);
  // A recursive JSON pass proves no raw source prose, source/evidence IDs,
  // candidate/mechanism IDs, hashes, or reachability witnesses are present.
  expect(leaves.every((leaf) => (
    (Number.isSafeInteger(leaf) && (leaf as number) >= 0)
    || leaf === "complete"
    || leaf === "incomplete"
  ))).toBe(true);
}

function answer(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
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
    reason: "disposition fixture answer",
  };
}

async function preparedFixture(
  pages = PAGES,
  moduleId = "source-fact-disposition",
): Promise<PreparedCompilerApiResult> {
  const prepared = await prepareCompiler({
    kind: "synthetic_pages",
    moduleId,
    sourceDescriptor: "source-fact-disposition",
    pages,
  });
  if (prepared.status === "refused") throw new Error(prepared.message);
  return prepared;
}

function mechanicallyClosedHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const entrance = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entrance")), "entrance scene");
  const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit scene");
  const rewardRows = [...draft.rewardCandidates].sort((left, right) => left.tableRowStatementId.localeCompare(right.tableRowStatementId));
  const gateKey = required(draft.itemCandidates[0], "Gate Key item");
  const mira = required(draft.proseNpcAnchors.find((anchor) => prepared.artifact.payload.graph.statements.find((statement) => statement.id === anchor.paragraphStatementId)?.text.includes("Mira")), "Mira anchor");
  const question = (kind: CompilerQuestion["kind"], subject?: string) => required(
    queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject)),
    `${kind} question`,
  );
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...allShellClueFactFacetResolutions(queue.questions, answer),
      ...draft.sceneCandidates.map((scene) => answer(question("scene_role", scene.id), { role: scene.id === entrance.id || scene.id === exit.id ? "playable_scene" : "other" })),
      answer(question("entry_scene"), { sceneCandidateId: entrance.id }),
      ...draft.sceneCandidates.map((scene) => answer(question("connection_topology", scene.id), {
        connections: scene.id === entrance.id ? [{ toSceneCandidateId: exit.id, connectionId: "entrance_exit" }] : [],
      })),
      answer(question("ending_rule"), {
        declarations: [{
          endingId: "leave_manor",
          spec: {
            kind: "ending_rule",
            id: "rule_leave_manor",
            priority: 1,
            when: { kind: "scene_visited", sceneId: exit.id },
            effects: [{ kind: "end_game", endingId: "leave_manor" }],
          },
        }],
      }),
      answer(question("npc_binding", mira.id), {
        proseAnchorId: mira.id,
        presentNpcs: [{ nameQuote: "Mira", dialogueMethods: [] }],
      }),
      answer(question("item_binding", gateKey.id), { itemCandidateId: gateKey.id, itemType: null }),
      answer(question("reward_binding", rewardRows[0]!.id), { rewardCandidateId: rewardRows[0]!.id, declaration: null }),
      answer(question("reward_binding", rewardRows[1]!.id), {
        rewardCandidateId: rewardRows[1]!.id,
        declaration: { when: { kind: "scene_visited", sceneId: exit.id }, settlement: { reputation: 2 } },
      }),
    ],
  };
}

/**
 * This uses the real compiler prepare/resolve fixture, then explicitly closes
 * every semantic question while choosing source-only/no-runtime bindings.
 * It is deliberately not a hand-built artifact or synthetic quality object.
 */
function completeSourceOnlyHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const base = mechanicallyClosedHints(prepared);
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const entry = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entrance")), "entry scene");
  const question = (kind: CompilerQuestion["kind"], subject?: string) => required(
    queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject)),
    `${kind} question`,
  );
  const retained = base.resolutions.filter((resolution) => ![
    "npc_binding",
    "item_binding",
    "reward_binding",
    "source_fact_disposition",
    "core_clue",
    "discovery_method",
  ].includes(resolution.kind));
  return {
    ...base,
    resolutions: [
      ...retained,
      ...draft.proseNpcAnchors.map((anchor) => answer(question("npc_binding", anchor.id), {
        proseAnchorId: anchor.id,
        presentNpcs: [],
      })),
      ...draft.itemCandidates.map((item) => answer(question("item_binding", item.id), {
        itemCandidateId: item.id,
        itemType: null,
      })),
      ...draft.rewardCandidates.map((reward) => answer(question("reward_binding", reward.id), {
        rewardCandidateId: reward.id,
        declaration: null,
      })),
      ...queue.questions.filter((candidate) => candidate.kind === "source_fact_disposition").map((candidate) => {
        if (!candidate.subjectStatementId) throw new Error("source fact disposition lacks statement subject");
        return answer(candidate, { statementId: candidate.subjectStatementId, disposition: "source_only" });
      }),
      ...draft.clueCandidates.map((clue) => answer(question("core_clue", clue.id), {
        clueCandidateId: clue.id,
        required: false,
      })),
      ...draft.clueCandidates.map((clue, index) => answer(question("discovery_method", clue.id), {
        clueCandidateId: clue.id,
        locationSceneCandidateId: entry.id,
        spec: {
          kind: "discovery_method",
          id: `complete-source-only-discovery-${index}`,
          clueId: clue.id,
          action: "search",
          target: "scene",
          targetId: entry.id,
          onSuccess: [{ kind: "discover_clue", clueId: clue.id }],
        },
      })),
    ],
  };
}

describe("deterministic source fact disposition", () => {
  it("accounts for every root statement without turning draft warnings into a mechanical gate", async () => {
    const prepared = await preparedFixture();
    const preparedReport = (prepared.artifact.payload as any).sourceFactDispositionReport;
    expect(preparedReport.contentReadiness).toMatchObject({ status: "incomplete" });
    expect(preparedReport.entries.some((entry: any) => entry.kind === "paragraph" && entry.status === "draft_candidate_open")).toBe(true);
    expect(preparedReport.entries.some((entry: any) => entry.kind === "table_row" && entry.status === "draft_candidate_open")).toBe(true);
    expect(preparedReport.entries.some((entry: any) => entry.kind === "list_item" && entry.status === "draft_candidate_open")).toBe(true);
    expect(preparedReport.counts.unmodeled).toBe(0);
    expect(preparedReport.counts.draft_candidate_open).toBeGreaterThan(0);
    expect(preparedReport.entries).toHaveLength(preparedReport.contentReadiness.rootStatementCount);
    expect(new Set(preparedReport.entries.map((entry: any) => entry.statementId)).size).toBe(preparedReport.contentReadiness.rootStatementCount);

    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, mechanicallyClosedHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload & { resolvedSourceFactDispositionReport: any };
    expect(payload.readiness.status).toBe("mechanically_closed");
    const report = payload.resolvedSourceFactDispositionReport;
    expect(report.contentReadiness).toMatchObject({ status: "incomplete" });
    expect(report.entries.find((entry: any) => entry.statementId === payload.rewardBindings.find((binding) => binding.declaration === null)!.tableRowStatementId)).toMatchObject({ status: "explicitly_unbound" });
    expect(report.entries.find((entry: any) => entry.statementId === payload.rewardBindings.find((binding) => binding.declaration !== null)!.tableRowStatementId)).toMatchObject({ status: "accepted_binding" });
    const sourceOnlyItem = payload.draft.itemCandidates[0]!;
    const sourceOnlyItemRoot = report.entries.find((entry: any) => entry.statementId === sourceOnlyItem.markedItemStatementId);
    expect(sourceOnlyItemRoot).toMatchObject({ status: "explicitly_unbound", reasons: expect.arrayContaining(["explicitly_unbound_item"]) });
    // Answering source-only does not answer the independently reviewed clue/discovery slots.
    expect(sourceOnlyItemRoot.openQuestionIds.length).toBeGreaterThan(0);
    expect(payload.itemBindings).toEqual([]);
    expect(payload.mechanicsIR.symbols.itemIds).toEqual([]);
    const acceptedNpcRoot = report.entries.find((entry: any) => entry.statementId === payload.proseNpcBindings[0]!.paragraphStatementId);
    expect(acceptedNpcRoot).toMatchObject({ status: "accepted_binding" });
    // The broad prose-discovery slot remains genuinely open on this same
    // paragraph. Primary status must not hide it or make content complete.
    expect(acceptedNpcRoot.openQuestionIds.length).toBeGreaterThan(0);
    const entranceHeading = payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entrance"))!.headingStatementId;
    expect(report.entries.find((entry: any) => entry.statementId === entranceHeading)).toMatchObject({ status: "mechanics_evidence" });
    const endingHeading = payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Ending"))!.headingStatementId;
    expect(report.entries.find((entry: any) => entry.statementId === endingHeading)).toMatchObject({ status: "mechanics_evidence" });
    expect(report.contentReadiness.openQuestionCount).toBeGreaterThan(0);
    expect(report.contentReadiness.openRootCount).toBeGreaterThan(0);
    expect(report.contentReadiness.unmodeledStatementIds).toEqual([]);
  });

  it("keeps content incomplete for an accepted root with open semantic slots even when no root is unmodeled", async () => {
    const prepared = await preparedFixture(ALL_PRIMARY_DISPOSITIONS_PAGES, "source-fact-disposition-all-primary");
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, mechanicallyClosedHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload & { resolvedSourceFactDispositionReport: any };
    const report = payload.resolvedSourceFactDispositionReport;
    const acceptedNpcRoot = report.entries.find((entry: any) => entry.statementId === payload.proseNpcBindings[0]!.paragraphStatementId);

    expect(payload.readiness.status).toBe("mechanically_closed");
    expect(report.counts.unmodeled).toBe(0);
    expect(report.entries.every((entry: any) => entry.status !== "unmodeled")).toBe(true);
    expect(acceptedNpcRoot).toMatchObject({ status: "accepted_binding" });
    expect(acceptedNpcRoot.openQuestionIds.length).toBeGreaterThan(0);
    expect(report.contentReadiness).toMatchObject({ status: "incomplete" });
    expect(report.contentReadiness.openQuestionCount).toBeGreaterThan(0);
  });

  it("reports complete source accounting separately from explicitly unbound runtime breadth", async () => {
    const prepared = await preparedFixture();
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, completeSourceOnlyHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const quality = summarizeCompilerRuntimeQuality(payload);

    expect(payload.readiness.status).toBe("mechanically_closed");
    expect(quality.sourceRootDisposition.dispositionReadiness).toBe("complete");
    expect(quality.sourceRootDisposition.positiveCoverage.sourceOnlyDecisionRootCount).toBeGreaterThan(0);
    expect(quality.sourceRootDisposition.counts.explicitly_unbound).toBeGreaterThan(0);
    expect(quality.coverage).toEqual({
      sceneCandidates: payload.draft.sceneCandidates.length,
      playableScenes: payload.mechanicsIR.symbols.sceneIds.length,
      clueCandidates: payload.draft.clueCandidates.length,
      proseDialogueClues: 0,
      proseFactFindingClues: 0,
      compiledClues: payload.mechanicsIR.symbols.clueIds.length,
      discoveryMethods: payload.mechanicsIR.discoveryMethods.length,
      itemCandidates: payload.draft.itemCandidates.length,
      boundItems: 0,
      runtimeItems: 0,
      proseNpcAnchors: payload.draft.proseNpcAnchors.length,
      boundNpcAnchors: 0,
      boundNpcs: 0,
      dialogueMethods: 0,
      encounters: 0,
      rewardCandidates: payload.draft.rewardCandidates.length,
      boundRewards: 0,
      runtimeRewards: 0,
      declaredEndings: payload.mechanicsIR.symbols.endingIds.length,
      reachableEndings: payload.reachabilityReport.reachableEndingIds.length,
    });
    expect(quality.coverage.itemCandidates).toBeGreaterThan(0);
    expect(quality.coverage.proseNpcAnchors).toBeGreaterThan(0);
    expect(quality.coverage.rewardCandidates).toBeGreaterThan(0);
    expect(quality.closedWorldIssueCounts).toEqual({
      unreachable_core_clue: 0,
      unreachable_ending: 0,
      core_clue_failure_policy_risk: 0,
      closed_world_deadlock: 0,
    });
    expectAggregateOnlyQuality(quality);
  });

  it("counts real positive source bindings separately from their candidate domains", async () => {
    const prepared = await preparedFixture();
    const baseHints = mechanicallyClosedHints(prepared);
    const itemBindings = baseHints.resolutions.filter((resolution) => resolution.kind === "item_binding");
    expect(itemBindings).toHaveLength(1);
    const item = prepared.artifact.payload.draft.itemCandidates[0]!;
    const itemName = prepared.artifact.payload.graph.statements.find((statement) => statement.id === item.nameStatementId)!;
    const hints: ModuleCompileHints = {
      ...baseHints,
      resolutions: baseHints.resolutions.map((resolution) => resolution.kind === "item_binding"
        ? {
          ...resolution,
          value: {
            ...(resolution.value as Record<string, unknown>),
            itemType: "key",
            itemNameEvidence: { statementId: itemName.id, quote: itemName.text },
          },
        }
        : resolution),
    };
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const quality = summarizeCompilerRuntimeQuality(payload);

    expect(payload.readiness.status).toBe("mechanically_closed");
    // Binding the item does not retroactively close the other source-fact
    // questions in this fixture; source readiness remains its own meaning.
    expect(quality.sourceRootDisposition.dispositionReadiness).toBe("incomplete");
    expect(quality.sourceRootDisposition.counts.explicitly_unbound).toBeGreaterThan(0);
    expect(quality.coverage).toMatchObject({
      itemCandidates: payload.draft.itemCandidates.length,
      proseFactFindingClues: 0,
      proseNpcAnchors: payload.draft.proseNpcAnchors.length,
      rewardCandidates: payload.draft.rewardCandidates.length,
      boundItems: 1,
      runtimeItems: 1,
      boundNpcAnchors: 1,
      boundNpcs: 1,
      boundRewards: 1,
      runtimeRewards: 1,
    });
    expect(quality.coverage.rewardCandidates).toBeGreaterThan(quality.coverage.boundRewards);
    expectAggregateOnlyQuality(quality);
  });

  it("fails closed when a source binding no longer agrees with its validated runtime symbols", async () => {
    const prepared = await preparedFixture();
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, mechanicallyClosedHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const forged = structuredClone(resolved.artifact.payload) as ResolvedCompilerArtifactPayload;
    forged.proseNpcBindings[0]!.npcId = "forged-runtime-npc";

    expect(() => summarizeCompilerRuntimeQuality(forged)).toThrow("runtime NPCs do not match their canonical runtime domain");
  });

  it("rejects a resealed prepared artifact whose canonical disposition report changes status, counts, root identity, evidence, or otherwise-valid audit detail", async () => {
    const prepared = await preparedFixture();
    const mutations: Array<(forged: any) => void> = [
      (forged) => { forged.payload.sourceFactDispositionReport.entries[0].status = "unmodeled"; },
      (forged) => { forged.payload.sourceFactDispositionReport.counts.unmodeled += 1; },
      (forged) => { forged.payload.sourceFactDispositionReport.entries[0].statementId = "forged_statement"; },
      (forged) => { forged.payload.sourceFactDispositionReport.entries[0].evidenceRefId = "forged_evidence"; },
      // Sorted/unique reasons retain a valid report shape and unchanged
      // status counts, so only deterministic regeneration may reject this.
      (forged) => { forged.payload.sourceFactDispositionReport.entries[0].reasons = [...forged.payload.sourceFactDispositionReport.entries[0].reasons, "forged_audit_reason"].sort(); },
    ];
    for (const mutate of mutations) {
      const forged = structuredClone(prepared.artifact) as any;
      mutate(forged);
      delete forged.artifactHash;
      expect(restoreCompilerArtifact(sealCompilerArtifact(forged))).toMatchObject({ status: "refused" });
    }
  });

  it("keeps ordinary state-transition heading coverage even when its ID resembles a source binding", async () => {
    const prepared = await preparedFixture();
    const { graph, draft, preparedQueue } = prepared.artifact.payload;
    const heading = required(graph.statements.find((statement) => statement.kind === "heading" && statement.text.startsWith("Entrance")), "Entrance heading");
    const scene = required(draft.sceneCandidates.find((candidate) => candidate.headingStatementId === heading.id), "Entrance scene");
    const interpretation: FactInterpretationCandidate<MechanicsCandidateSpec> = {
      id: "source_interpretation_prefix_but_not_a_binding",
      sourceStatementIds: [heading.id],
      claim: {
        path: "mechanics.state_transition.ordinary_heading_transition",
        value: {
          kind: "state_transition",
          id: "ordinary_heading_transition",
          when: { kind: "current_scene", sceneId: scene.id },
          effects: [{ kind: "set_state", stateKey: "ordinary_heading_state", value: true }],
        },
        domain: "gameplay_mechanic",
        authority: "user_document",
        derivation: "explicit",
        status: "accepted",
        evidenceRefs: [heading.evidenceRefId],
        sourceRef: null,
        confidence: null,
        reason: "ordinary state transition report fixture",
        rightsStatus: "user_provided",
        scope: { moduleId: draft.moduleId },
      },
      interpretationStatus: "accepted",
      review: {
        interpretationId: "source_interpretation_prefix_but_not_a_binding",
        decision: "accept",
        reason: "ordinary state transition report fixture",
        reviewerKind: "human",
        reviewEvidenceStatementIds: [heading.id],
      },
    };
    const report = buildResolvedSourceFactDispositionReport(graph, draft, preparedQueue, [interpretation], {
      proseNpcBindings: [], itemBindings: [], rewardBindings: [], sourceFactMechanicBindings: [],
    });
    expect(required(report.entries.find((entry) => entry.statementId === heading.id), "heading report entry")).toMatchObject({
      positiveCoverage: true,
      hasMechanicsEvidence: true,
      reasons: expect.arrayContaining(["accepted_mechanics_interpretation"]),
    });
  });
});
