import { describe, expect, it } from "bun:test";
import { GameSession, compiledMechanicsAction } from "../api/game-session";
import { requestCompilerHintProposals } from "../api/compiler-hint-proposal-adapter";
import { restoreCompilerArtifact, type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { applyModuleCompileHints, resolveDraftModule } from "../compiler/compile-hint-resolution";
import { buildCompilerHintProposalRequestEnvelope } from "../compiler/compiler-hint-proposals";
import { projectResolvedCompilerArtifact, projectTrustedResolvedCompilerArtifact, trustedPresentationReviewIdentity, TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION, type ModuleDataPresentationMetadata, type TrustedPresentationReview } from "../compiler/compiler-module-data-projection";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";

const SESSION_CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

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
    reason: "source-exact clue fact facet test fixture",
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function facetHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const scene = (name: string) => required(draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name)), `scene ${name}`);
  const clue = (name: string) => required(draft.clueCandidates.find((candidate) => candidate.displayName === name), `clue ${name}`);
  const entry = scene("Entry");
  const archive = scene("Archive");
  const exit = scene("Exit");
  const corpse = clue("Corpse");
  const topology = (sceneId: string) => required(queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === sceneId), `topology ${sceneId}`);
  const core = (clueId: string) => required(queue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === clueId), `core ${clueId}`);
  const finding = (question: CompilerQuestion) => {
    const atoms = required(question.allowedClueFactAtoms, `facet atoms ${question.id}`);
    const incision = atoms.find((atom) => atom.quote === "Medicine reveals a precise incision.");
    if (question.subjectCandidateId !== corpse.id || !incision) {
      return { shell: atoms.map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] };
    }
    return {
      shell: atoms.filter((atom) => atom.id !== incision.id).map((atom) => ({ atomId: atom.id, quote: atom.quote })),
      findings: [{
        findingKey: "medicine-incision",
        atoms: [{ atomId: incision.id, quote: incision.quote }],
        methods: [{
          declarationKey: "medicine-search",
          action: "search",
          target: "clue",
          check: { kind: "skill", skill: "medicine", difficulty: "regular" },
          failback: { maxFailures: 1 },
        }],
      }],
      sourceOnlyAtomIds: [],
    };
  };
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => answer(question, { role: "playable_scene" })),
      answer(required(queue.questions.find((question) => question.kind === "entry_scene"), "entry question"), { sceneCandidateId: entry.id }),
      answer(topology(entry.id), { connections: [{ toSceneCandidateId: archive.id, connectionId: "entry_archive" }] }),
      answer(topology(archive.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "archive_exit" }] }),
      answer(topology(exit.id), { connections: [] }),
      ...draft.clueCandidates.map((candidate) => answer(core(candidate.id), { clueCandidateId: candidate.id, required: candidate.id === corpse.id })),
      ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => answer(question, finding(question))),
      ...queue.questions.filter((question) => question.kind === "item_binding").map((question) => answer(question, { itemCandidateId: question.subjectCandidateId, itemType: null })),
      answer(required(queue.questions.find((question) => question.kind === "ending_rule"), "ending question"), {
        declarations: [{
          endingId: "ending_incident_resolved",
          spec: {
            kind: "ending_rule",
            id: "rule_incident_resolved",
            priority: 1,
            when: { kind: "all", predicates: [{ kind: "clue_found", clueId: corpse.id }, { kind: "scene_visited", sceneId: exit.id }] },
            effects: [{ kind: "end_game", endingId: "ending_incident_resolved" }],
          },
        }, {
          endingId: "ending_hasty_departure",
          spec: {
            kind: "ending_rule",
            id: "rule_hasty_departure",
            priority: 2,
            when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "clue_found", clueId: corpse.id } }] },
            effects: [{ kind: "end_game", endingId: "ending_hasty_departure" }],
          },
        }],
      }),
    ],
  };
}

function facetPresentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const display = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    const shell = binding.shellAtoms.map((atom) => atom.quote).join("\n") || required(payload.draft.clueCandidates.find((candidate) => candidate.id === binding.clueId), `shell ${binding.clueId}`).displayName;
    if (binding.shellAtoms.length || binding.findings.length) display.set(binding.clueId, shell);
    for (const finding of binding.findings) display.set(finding.clueId, finding.atoms.map((atom) => atom.quote).join("\n"));
  }
  return {
    module: { title: "Facet fixture", version: "1", ruleset: "cosmic-horror", era: "test", summary: "test", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: `scene ${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: `connection ${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, { findMethods: [], revelation: required(display.get(id), `facet display ${id}`), unlocks: [], importance: "bonus" as const }])),
    endings: {
      ending_incident_resolved: { name: "Resolved", description: "The incident is resolved.", conditions: ["The body is found."] },
      ending_hasty_departure: { name: "Hasty", description: "The party departs without the body.", conditions: ["The body is not found."] },
    },
  };
}

describe("marked clue fact facets", () => {
  it("partitions a cross-page marked body at source-page boundaries without widening atom evidence", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "clue-fact-facet-cross-page",
      sourceDescriptor: "clue-fact-facet-cross-page",
      pages: [
        "Infirmary:\n\u25b6 Report: First source atom. Cross-page source atom begins ",
        "and finishes on the next page.",
      ],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);

    const clue = required(prepared.artifact.payload.draft.clueCandidates.find((candidate) => candidate.displayName === "Report"), "cross-page clue");
    const atoms = prepared.artifact.payload.draft.clueFactAtoms.filter((atom) => atom.clueCandidateId === clue.id);
    const question = required(prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.kind === "clue_fact_facets" && candidate.subjectCandidateId === clue.id), "cross-page facet question");

    expect(atoms.map((atom) => atom.quote)).toEqual([
      "First source atom.",
      "Cross-page source atom begins",
      "and finishes on the next page.",
    ]);
    expect(atoms.map((atom) => atom.evidence.spans)).toEqual(atoms.map((atom) => [expect.objectContaining({ exactText: atom.quote })]));
    expect(atoms.every((atom) => atom.evidence.spans.length === 1 && atom.evidence.spans[0]?.exactText === atom.quote)).toBe(true);
    expect(question.allowedClueFactAtoms?.map((atom) => atom.quote)).toEqual(atoms.map((atom) => atom.quote));
    const body = required(prepared.artifact.payload.graph.statements.find((statement) => statement.id === clue.bodyStatementId), "cross-page body");
    expect(atoms.map((atom) => atom.quote).join("").replace(/\s/g, "")).toBe(body.text.replace(/\s/g, ""));
  });

  it("prepares independently evidence-bound body atoms for an explicit shell/finding partition", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "clue-fact-facet-red",
      sourceDescriptor: "clue-fact-facet-red",
      pages: ["Infirmary:\n▶Corpse: The body is cold. Medicine reveals a precise incision."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);

    const clue = prepared.artifact.payload.draft.clueCandidates[0]!;
    const atoms = (prepared.artifact.payload.draft as any).clueFactAtoms
      .filter((atom: { clueCandidateId: string }) => atom.clueCandidateId === clue.id);
    const facetQuestion = prepared.artifact.payload.preparedQueue.questions
      .find((question) => question.kind === ("clue_fact_facets" as any) && question.subjectCandidateId === clue.id) as any;

    expect(atoms).toMatchObject([
      { quote: "The body is cold." },
      { quote: "Medicine reveals a precise incision." },
    ]);
    expect(atoms.every((atom: { evidence: { spans: Array<{ exactText: string }> }; quote: string }) => atom.evidence.spans.length === 1 && atom.evidence.spans[0]?.exactText === atom.quote)).toBe(true);
    expect(facetQuestion).toMatchObject({
      kind: "clue_fact_facets",
      subjectCandidateId: clue.id,
    });
    expect(facetQuestion.allowedClueFactAtoms).toEqual(expect.arrayContaining(atoms.map((atom: { id: string; quote: string }) => expect.objectContaining({ id: atom.id, quote: atom.quote }))));
  });

  it("keeps a balanced bracketed source segment as its own independently verified atom", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "clue-fact-facet-brackets",
      sourceDescriptor: "clue-fact-facet-brackets",
      pages: ["Infirmary:\n▶Case Note: The body is cold. [Medicine reveals a precise incision.]"],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const clue = required(prepared.artifact.payload.draft.clueCandidates.find((candidate) => candidate.displayName === "CaseNote"), "bracket clue");
    const atoms = prepared.artifact.payload.draft.clueFactAtoms.filter((atom) => atom.clueCandidateId === clue.id);
    expect(atoms.map((atom) => atom.quote)).toEqual(["The body is cold.", "[Medicine reveals a precise incision.]"]);
    expect(atoms.every((atom) => atom.evidence.spans.length === 1 && atom.evidence.spans[0]?.exactText === atom.quote)).toBe(true);
  });

  it("renders multi-atom facets in source order, never derived hash-ID order", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "clue-fact-facet-source-order",
      sourceDescriptor: "clue-fact-facet-source-order",
      pages: ["Infirmary:\n\u25B6 Report: First source atom. Second source atom. Third source atom."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const question = required(queue.questions.find((candidate) => candidate.kind === "clue_fact_facets"), "source order facet question");
    const atoms = required(question.allowedClueFactAtoms, "source order atoms");
    expect(atoms.length).toBe(3);
    // This intentionally gives the parser a non-source ordering.  Source spans,
    // not IDs or caller order, own the resolved display order.
    const reversed = [...atoms].reverse();
    const hints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [answer(question, {
        shell: reversed.map((atom) => ({ atomId: atom.id, quote: atom.quote })),
        findings: [],
        sourceOnlyAtomIds: [],
      })],
    };
    const resolved = resolveDraftModule(graph, draft, queue, hints);
    const binding = required(resolved.clueFactFacetBindings[0], "source ordered facet binding");
    expect(binding.shellAtoms.map((atom) => atom.quote)).toEqual(atoms.map((atom) => atom.quote));
  });

  it("rejects caller-owned identities, foreign quotes, duplicate slots, overlap, and incomplete facet partitions", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "clue-fact-facet-negative",
      sourceDescriptor: "clue-fact-facet-negative",
      pages: ["Infirmary:\n▶Corpse: The body is cold. Medicine reveals a precise incision.\n\nOffice:\n▶Ledger: The ledger names the culprit."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, preparedQueue: queue } = prepared.artifact.payload;
    const corpse = required(prepared.artifact.payload.draft.clueCandidates.find((candidate) => candidate.displayName === "Corpse"), "corpse candidate");
    const question = required(queue.questions.find((candidate) => candidate.kind === "clue_fact_facets" && candidate.subjectCandidateId === corpse.id), "corpse facet question");
    const atoms = required(question.allowedClueFactAtoms, "corpse atoms");
    const first = required(atoms.find((atom) => atom.quote === "The body is cold."), "shell atom");
    const second = required(atoms.find((atom) => atom.quote === "Medicine reveals a precise incision."), "finding atom");
    const foreign = required(queue.questions.find((candidate) => candidate.kind === "clue_fact_facets" && candidate.subjectCandidateId !== corpse.id)?.allowedClueFactAtoms?.[0], "foreign atom");
    const hints = (value: unknown): ModuleCompileHints => ({
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [answer(question, value)],
    });
    const clean = {
      shell: [{ atomId: first.id, quote: first.quote }],
      findings: [{
        findingKey: "medicine-incision",
        atoms: [{ atomId: second.id, quote: second.quote }],
        methods: [{ declarationKey: "medicine-search", action: "search", target: "clue", check: { kind: "skill", skill: "medicine", difficulty: "regular" }, failback: { maxFailures: 1 } }],
      }],
      sourceOnlyAtomIds: [],
    };
    expect(() => applyModuleCompileHints(graph, queue, hints(clean))).not.toThrow();

    const forgedFindingId = structuredClone(clean) as any;
    forgedFindingId.findings[0].clueId = "caller_clue";
    expect(() => applyModuleCompileHints(graph, queue, hints(forgedFindingId))).toThrow("undeclared clue_fact_facets.findings[0] field: clueId");
    const forgedMechanismId = structuredClone(clean) as any;
    forgedMechanismId.findings[0].methods[0].mechanismId = "caller_mechanism";
    expect(() => applyModuleCompileHints(graph, queue, hints(forgedMechanismId))).toThrow("undeclared clue_fact_facets.findings[0].methods[0] field: mechanismId");
    const forgedPredicateAst = structuredClone(clean) as any;
    forgedPredicateAst.findings[0].methods[0].availability = { kind: "clue_found", clueId: corpse.id };
    expect(() => applyModuleCompileHints(graph, queue, hints(forgedPredicateAst))).toThrow("undeclared clue_fact_facets.findings[0].methods[0] field: availability");
    const crossHeading = structuredClone(clean) as any;
    crossHeading.shell[0] = { atomId: foreign.id, quote: foreign.quote };
    expect(() => applyModuleCompileHints(graph, queue, hints(crossHeading))).toThrow("must exactly repeat one offered body atom quote");
    const overlap = structuredClone(clean) as any;
    overlap.sourceOnlyAtomIds = [first.id];
    expect(() => applyModuleCompileHints(graph, queue, hints(overlap))).toThrow("clue fact partition");
    const incomplete = structuredClone(clean) as any;
    incomplete.findings = [];
    expect(() => applyModuleCompileHints(graph, queue, hints(incomplete))).toThrow("clue fact partition");
    const duplicateSlot = structuredClone(clean) as any;
    duplicateSlot.findings[0].methods.push({ declarationKey: "second-medicine-search", action: "search", target: "clue", check: { kind: "skill", skill: "medicine", difficulty: "regular" }, failback: { maxFailures: 1 } });
    expect(() => applyModuleCompileHints(graph, queue, hints(duplicateSlot))).toThrow("occupied method slot");
    const unboundItemAction = structuredClone(clean) as any;
    unboundItemAction.findings[0].methods[0].action = "use_item";
    expect(() => applyModuleCompileHints(graph, queue, hints(unboundItemAction))).toThrow("observe/search on scene|clue or read on clue");
  });

  it("lets an all-source-only clue under a non-playable heading retire its default discovery", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "clue-fact-facet-source-only-rules",
      sourceDescriptor: "clue-fact-facet-source-only-rules",
      pages: ["Rules:\n\u25B6 Appendix: This is keeper-only background."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const sceneRole = required(queue.questions.find((question) => question.kind === "scene_role"), "rules scene role");
    const facet = required(queue.questions.find((question) => question.kind === "clue_fact_facets"), "rules facet question");
    const atoms = required(facet.allowedClueFactAtoms, "rules source-only atoms");
    const hints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        answer(sceneRole, { role: "rules_section" }),
        answer(facet, { shell: [], findings: [], sourceOnlyAtomIds: atoms.map((atom) => atom.id) }),
      ],
    };
    const resolved = resolveDraftModule(graph, draft, queue, hints);
    expect(resolved.clueFactFacetBindings).toHaveLength(1);
    expect(resolved.readiness.blockingCodes).not.toContain("invalid_default_discovery_binding");
    expect(resolved.acceptedInterpretations.some((interpretation) => interpretation.claim.value?.kind === "discovery_method")).toBe(false);
  });

  it("allows a trusted automatic exact-atom proposal but rejects a tampered audit quote", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "clue-fact-facet-auto-proposal",
      sourceDescriptor: "clue-fact-facet-auto-proposal",
      pages: ["Infirmary:\n\u25B6 Corpse: The body is cold. Medicine reveals a precise incision."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, preparedQueue: queue } = prepared.artifact.payload;
    const envelope = buildCompilerHintProposalRequestEnvelope(graph, queue, { policyId: "facet-auto", rightsStatus: "user_provided" });
    expect(envelope.schemaVersion).toBe("1.8.0");
    const requestQuestion = required(envelope.questions.find((question) => question.kind === "clue_fact_facets"), "automatic facet request question");
    const shellClueId = required(requestQuestion.candidateDomains.subjectCandidateId, "automatic facet request shell ID");
    expect(requestQuestion.allowedKinds).toEqual(["clue_fact_facets"]);
    expect(requestQuestion.candidateDomains.allowedClueFactAtoms?.map((atom) => atom.quote)).toEqual(["The body is cold.", "Medicine reveals a precise incision."]);

    const fake = {
      async chat(messages: Array<{ content: string }>): Promise<string> {
        const marker = "REQUEST ENVELOPE:\n";
        const content = messages[1]!.content;
        const request = JSON.parse(content.slice(content.lastIndexOf(marker) + marker.length)) as typeof envelope;
        const question = request.questions.find((candidate) => candidate.kind === "clue_fact_facets");
        if (!question) return JSON.stringify({ proposals: [] });
        const clueId = required(question.candidateDomains.subjectCandidateId, "automatic facet shell ID");
        const atoms = required(question.candidateDomains.allowedClueFactAtoms, "automatic facet atom domain");
        const shell = required(atoms.find((atom) => atom.quote === "The body is cold."), "automatic facet shell atom");
        const finding = required(atoms.find((atom) => atom.quote.includes("Medicine reveals")), "automatic facet finding atom");
        return JSON.stringify({ proposals: [{
          questionId: question.questionId,
          kind: question.kind,
          value: {
            shell: [{ atomId: shell.atomId, quote: shell.quote }],
            findings: [{
              findingKey: "automatic-medicine",
              atoms: [{ atomId: finding.atomId, quote: finding.quote }],
              methods: [{ declarationKey: "automatic-medicine-search", action: "search", target: "clue", check: { kind: "skill", skill: "medicine", difficulty: "regular" } }],
            }],
            sourceOnlyAtomIds: [],
          },
          citations: [
            { claimKey: `clue_fact_shell:${clueId}:${shell.atomId}`, statementId: shell.statementId, quote: shell.quote },
            { claimKey: `clue_fact_finding:automatic-medicine:${finding.atomId}`, statementId: finding.statementId, quote: finding.quote },
            { claimKey: "clue_fact_method:automatic-medicine:automatic-medicine-search", statementId: finding.statementId, quote: finding.quote },
          ],
        }] });
      },
    };
    const proposed = await requestCompilerHintProposals({
      graph,
      queue,
      llm: fake,
      policy: { policyId: "facet-auto", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "facet-test", modelFingerprint: "deterministic" },
      limits: { maxQuestionsPerRequest: 8, maxRequestsPerRound: 8, maxRequestChars: 48_000, maxResponseTokens: 512 },
    });
    expect(proposed.accepted).toHaveLength(1);
    expect(proposed.accepted[0]!.resolution.reviewerKind).toBe("approved_policy");
    expect(() => applyModuleCompileHints(graph, queue, proposed.hints)).not.toThrow();
    const autoResolved = resolveDraftModule(graph, prepared.artifact.payload.draft, queue, proposed.hints);
    const autoFinding = required(autoResolved.clueFactFacetBindings[0]?.findings[0], "automatic derived finding binding");
    expect(autoFinding.methods[0]!.spec.availability).toMatchObject({
      kind: "all",
      predicates: expect.arrayContaining([{ kind: "clue_found", clueId: shellClueId }]),
    });

    const tampered = structuredClone(proposed.hints) as any;
    // Still an offered raw atom quote, but bound to the wrong shell claim:
    // generic source checks must not substitute for claim-to-atom validation.
    tampered.resolutions[0].audit.citations[0].quote = "Medicine reveals a precise incision.";
    expect(() => applyModuleCompileHints(graph, queue, tampered)).toThrow("clue fact facet citation must exactly quote its offered atom");
  });

  it("keeps a shell and checked finding separate through resolve, projection, artifact restore, and GameSession", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "clue-fact-facet-e2e",
      sourceDescriptor: "clue-fact-facet-e2e",
      pages: ["Entry:\n▶Corpse: The body is cold. Medicine reveals a precise incision.\n\nArchive:\n▶Ledger: The ledger names the culprit.\n\nExit:\n▶Exit Door: The door leads outside."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);

    const hints = facetHints(prepared);
    const draftResolution = resolveDraftModule(prepared.artifact.payload.graph, prepared.artifact.payload.draft, prepared.artifact.payload.preparedQueue, hints);
    if (!draftResolution.mechanicsIR) throw new Error(JSON.stringify(draftResolution.readiness));
    const resolvedResult = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    if (resolvedResult.status === "refused") throw new Error(JSON.stringify({ message: resolvedResult.message, readiness: draftResolution.readiness, report: draftResolution.reachabilityReport }));
    const payload = resolvedResult.artifact.payload as ResolvedCompilerArtifactPayload;
    const corpse = required(payload.draft.clueCandidates.find((candidate) => candidate.displayName === "Corpse"), "corpse shell");
    const corpseBinding = required(payload.clueFactFacetBindings.find((binding) => binding.clueId === corpse.id), "corpse facets");
    const incision = required(corpseBinding.findings[0], "medicine finding");
    const method = required(incision.methods[0], "medicine finding method");

    expect(payload.mechanicsIR.symbols.clueIds).toEqual(expect.arrayContaining([corpse.id, incision.clueId]));
    expect(payload.reachabilityReport.reachableClueIds).toContain(incision.clueId);
    expect(method.spec.availability).toEqual({
      kind: "all",
      predicates: [
        { kind: "clue_found", clueId: corpse.id },
        { kind: "not", predicate: { kind: "clue_found", clueId: incision.clueId } },
      ],
    });

    const projection = projectResolvedCompilerArtifact(payload, facetPresentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const scene = required(projection.module.scenes.find((candidate) => candidate.id === corpse.sceneCandidateId), "corpse scene");
    const shell = required(scene.clues.find((candidate) => candidate.id === corpse.id), "shell projection");
    const finding = required(scene.clues.find((candidate) => candidate.id === incision.clueId), "finding projection");
    expect(shell.description).toBe("The body is cold.");
    expect(shell.revelation).toBe("The body is cold.");
    expect(shell.description).not.toContain("Medicine reveals");
    expect(finding.description).toBe("Medicine reveals a precise incision.");
    expect(finding.revelation).toBe("Medicine reveals a precise incision.");
    expect(projection.sourceMap.scenes[scene.id]!.clues[corpse.id]!.fields.description).toMatchObject({
      kind: "resolved_question",
      quotes: [{ quote: "The body is cold." }],
    });
    expect(projection.sourceMap.scenes[scene.id]!.clues[corpse.id]!.fields.description).toMatchObject({
      claimKeys: [`clue_fact_shell:${corpse.id}:${corpseBinding.shellAtoms[0]!.atomId}`],
    });
    // The marked-item identity name is structural source provenance, not a
    // body-atom claim. Finding names, by contrast, remain fact-derived.
    expect(projection.sourceMap.scenes[scene.id]!.clues[corpse.id]!.fields.name).toMatchObject({
      kind: "source_exact",
      statements: [{ statementId: corpse.nameStatementId }],
    });
    expect(finding.findMethods).toEqual([{ type: "skill", skillName: "medicine", difficulty: "regular", description: "Search this clue." }]);
    expect(finding.findMethods[0]!.description).not.toContain("Medicine reveals");
    expect(projection.sourceMap.scenes[scene.id]!.clues[incision.clueId]!.findMethods[method.mechanismId]!.fields.description).toMatchObject({ kind: "artifact" });

    const review: TrustedPresentationReview = {
      schemaVersion: TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION,
      id: "a".repeat(24),
      reviewerPrincipalId: "keeper:facet-test",
      reviewedAt: "2026-09-24T00:00:00.000Z",
      preparedArtifactId: "b".repeat(24),
      preparedArtifactHash: prepared.artifact.artifactHash,
      preparedIdentity: prepared.identity,
      resolvedArtifactHash: resolvedResult.artifact.artifactHash,
      resolvedIdentity: payload.identity,
      bindings: exactReviewBindings(payload),
      reviewHash: "",
    };
    review.reviewHash = trustedPresentationReviewIdentity(review);
    const trusted = projectTrustedResolvedCompilerArtifact(payload, review);
    if (trusted.status === "refused") throw new Error(trusted.message);
    const trustedScene = required(trusted.module.scenes.find((candidate) => candidate.id === scene.id), "trusted corpse scene");
    expect(required(trustedScene.clues.find((candidate) => candidate.id === corpse.id), "trusted shell").description).toBe("The body is cold.");
    expect(trusted.sourceMap.scenes[scene.id]!.clues[corpse.id]!.fields.revelation).toMatchObject({ kind: "resolved_question", quotes: [{ quote: "The body is cold." }] });

    const tampered = structuredClone(resolvedResult.artifact);
    ((tampered.payload as ResolvedCompilerArtifactPayload).clueFactFacetBindings[0]!.shellAtoms[0] as { quote: string }).quote = "forged disclosure";
    expect(restoreCompilerArtifact(tampered)).toMatchObject({ status: "refused" });

    const session = new GameSession("clue-fact-facet-session", "cosmic-horror", SESSION_CONFIG, "investigator", "Ada");
    expect(session.loadCompiledModule(payload, projection)).toMatchObject({ status: "loaded" });
    expect(session.getCompiledAvailableActions().map((action) => action.mechanismId)).not.toContain(method.mechanismId);
    const shellMethod = required(payload.mechanicsIR.discoveryMethods.find((candidate) => candidate.clueId === corpse.id), "shell method");
    expect((await session.act(compiledMechanicsAction(shellMethod.id))).error).toBeUndefined();
    expect(session.getCompiledAvailableActions().map((action) => action.mechanismId)).toContain(method.mechanismId);

    const originalRandom = Math.random;
    try {
      Math.random = () => 0.99;
      expect((await session.act(compiledMechanicsAction(method.mechanismId))).error).toBeUndefined();
      expect(session.getCompiledAvailableActions().map((action) => action.mechanismId)).toContain(method.mechanismId);
      expect((await session.act(compiledMechanicsAction(method.mechanismId))).error).toBeUndefined();
    } finally {
      Math.random = originalRandom;
    }
    expect(session.getCompiledAvailableActions().map((action) => action.mechanismId)).not.toContain(method.mechanismId);
  });
});
