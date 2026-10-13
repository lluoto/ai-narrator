import { describe, expect, it } from "bun:test";
import { parseCompilerHintValue, resolveDraftModule } from "../compiler/compile-hint-resolution";
import { buildCompilerQuestionQueue, MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

function fixture(extraText = "") {
  const document = createSyntheticDocumentIR([
    "入口：\n普通叙述不能凭空绑定线索。\n▶父线索：一把刻有档案室标记的钥匙。\n档案室：\n▶子线索：一份需要检定才能读懂的档案。\n出口：\n▶出口说明：离开这里的旧车票。" + extraText,
  ], "compiler-closure-fixture");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "compiler-closure-fixture" });
  const queue = buildCompilerQuestionQueue(graph, draft);
  return { graph, draft, queue };
}

function resolution(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
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
    reason: "explicit benchmark declaration bound to this queue evidence",
  };
}

function closureHints(data: ReturnType<typeof fixture>): ModuleCompileHints {
  const { draft, queue } = data;
  const scene = (name: string) => draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name))!;
  const clue = (name: string) => draft.clueCandidates.find((candidate) => candidate.displayName === name)!;
  const entry = scene("入口");
  const archive = scene("档案室");
  const exit = scene("出口");
  const parent = clue("父线索");
  const child = clue("子线索");
  const roleQuestions = queue.questions.filter((question) => question.kind === "scene_role");
  const topology = (sceneId: string) => queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === sceneId)!;
  const core = (clueId: string) => queue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === clueId)!;
  const discovery = (clueId: string) => queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === clueId)!;
  const entryQuestion = queue.questions.find((question) => question.kind === "entry_scene")!;
  const endingQuestion = queue.questions.find((question) => question.kind === "ending_rule")!;
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      // These mechanics fixtures intentionally disclose each exact atom as a
      // shell.  It is a reviewer answer, never a compiler fallback.
      ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => resolution(question, {
        shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })),
        findings: [],
        sourceOnlyAtomIds: [],
      })),
      ...roleQuestions.map((question) => resolution(question, { role: "playable_scene" })),
      resolution(entryQuestion, { sceneCandidateId: entry.id }),
      resolution(topology(entry.id), { connections: [
        { toSceneCandidateId: archive.id, connectionId: "connection_entry_archive" },
        { toSceneCandidateId: exit.id, connectionId: "connection_entry_exit" },
      ] }),
      resolution(topology(archive.id), { connections: [
        { toSceneCandidateId: entry.id, connectionId: "connection_archive_entry" },
        { toSceneCandidateId: exit.id, connectionId: "connection_archive_exit", availability: { kind: "connection_unlocked", connectionId: "connection_archive_exit" } },
      ] }),
      // Empty is an answer: this scene deliberately has no outgoing edge.
      resolution(topology(exit.id), { connections: [] }),
      resolution(core(parent.id), { clueCandidateId: parent.id, required: false }),
      resolution(core(child.id), { clueCandidateId: child.id, required: true }),
      resolution(discovery(parent.id), { clueCandidateId: parent.id, locationSceneCandidateId: entry.id, spec: {
        kind: "discovery_method", id: "discover_parent_explicit", clueId: parent.id, action: "search", target: "scene", targetId: entry.id,
        onSuccess: [{ kind: "discover_clue", clueId: parent.id }],
      } }),
      resolution(discovery(child.id), { clueCandidateId: child.id, locationSceneCandidateId: archive.id, spec: {
        kind: "discovery_method", id: "discover_child_checked", clueId: child.id, action: "read", target: "scene", targetId: archive.id,
        availability: { kind: "clue_found", clueId: parent.id }, check: { kind: "skill", skill: "library_use", difficulty: "hard" },
        onSuccess: [{ kind: "discover_clue", clueId: child.id }, { kind: "unlock_connection", connectionId: "connection_archive_exit" }],
        failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: child.id }, { kind: "unlock_connection", connectionId: "connection_archive_exit" }] },
      } }),
      resolution(endingQuestion, { declarations: [
        { endingId: "ending_clean_escape", spec: {
          kind: "ending_rule", id: "rule_clean_escape", priority: 10,
          when: { kind: "all", predicates: [{ kind: "clue_found", clueId: child.id }, { kind: "scene_visited", sceneId: exit.id }] },
          effects: [{ kind: "end_game", endingId: "ending_clean_escape" }],
        } },
        { endingId: "ending_hasty_exit", spec: {
          kind: "ending_rule", id: "rule_hasty_exit", priority: 20,
          when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "clue_found", clueId: child.id } }] },
          effects: [{ kind: "end_game", endingId: "ending_hasty_exit" }],
        } },
      ] }),
    ],
  };
}

describe("document structure to closed-world compilation", () => {
  for (const fault of ["other_clue", "unknown_clue", "unknown_scene"] as const) {
    it(`structurally audits substituted defaults: ${fault}`, () => {
      const data = fixture();
      const policy = data.draft.interpretations[0]!;
      const spec = policy.claim.value;
      if (!spec || spec.kind !== "discovery_method") throw new Error("fixture requires discovery");
      if (fault === "other_clue") spec.onSuccess = [{ kind: "discover_clue", clueId: data.draft.clueCandidates[1]!.id }];
      if (fault === "unknown_clue") spec.onSuccess.push({ kind: "discover_clue", clueId: "nonexistent_clue" });
      if (fault === "unknown_scene") spec.availability = { kind: "scene_visited", sceneId: "nonexistent_scene" };
      expect(() => resolveDraftModule(data.graph, data.draft, data.queue, closureHints(data))).toThrow(fault === "other_clue" ? "must discover its clue" : fault === "unknown_clue" ? "unknown clue" : "unknown scene");
    });
  }

  it("audits valid original scene references without replacement-only symbols", () => {
    const data = fixture("\nRules:\nReference text.");
    const policy = data.draft.interpretations[0]!;
    const spec = policy.claim.value;
    if (!spec || spec.kind !== "discovery_method") throw new Error("fixture requires discovery");
    const rules = data.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Rules"))!;
    spec.availability = { kind: "scene_visited", sceneId: rules.id };
    const hints = closureHints(data);
    const role = data.queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === rules.id)!;
    hints.resolutions.find((answer) => answer.questionId === role.id)!.value = { role: "rules_section" };
    const topology = data.queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === rules.id)!;
    hints.resolutions.push(resolution(topology, { connections: [] }));
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, hints);
    expect(resolved.readiness.status).toBe("mechanically_closed");
    expect(resolved.substitutedEnginePolicyInterpretationIds).toContain(policy.id);
    expect(resolved.mechanicsIR!.symbols.sceneIds).not.toContain(rules.id);
  });

  for (const updateReview of [false, true]) {
    it(`rejects complete subtree rebinding with preserved identity, updated review=${updateReview}`, () => {
      const data = fixture();
      const originalGraph = structuredClone(data.graph);
      const parent = data.draft.clueCandidates[0]!;
      const child = data.draft.clueCandidates[1]!;
      parent.markedItemStatementId = child.markedItemStatementId;
      parent.nameStatementId = child.nameStatementId;
      parent.bodyStatementId = child.bodyStatementId;
      parent.sceneCandidateId = child.sceneCandidateId;
      const policy = data.draft.interpretations[0]!;
      const spec = policy.claim.value;
      if (!spec || spec.kind !== "discovery_method") throw new Error("fixture requires discovery");
      spec.targetId = child.sceneCandidateId;
      const subtree = data.draft.interpretations[1]!.sourceStatementIds;
      policy.sourceStatementIds = [...new Set([...policy.sourceStatementIds, ...subtree])];
      policy.claim.evidenceRefs = policy.sourceStatementIds.map((id) => data.graph.statements.find((statement) => statement.id === id)!.evidenceRefId);
      if (updateReview) policy.review!.reviewEvidenceStatementIds = [...policy.sourceStatementIds];
      // Keep one candidate per genuine subtree so duplicate-question validation cannot mask identity.
      data.draft.clueCandidates = data.draft.clueCandidates.filter((clue) => clue.id !== child.id);
      data.draft.interpretations = data.draft.interpretations.filter((candidate) => candidate !== data.draft.interpretations[1]);
      // Facet questions now validate the canonical marked-item subtree while
      // rebuilding the queue, which rejects this attempted identity rewrite
      // earlier than the former default-location readiness check.
      expect(() => buildCompilerQuestionQueue(data.graph, data.draft)).toThrow("canonical marked clue heading scope");
      expect(data.graph).toEqual(originalGraph);
    });
  }

  it("requires review evidence for the actual default binding subtree", () => {
    const data = fixture();
    const policy = data.draft.interpretations[0]!;
    policy.review!.reviewEvidenceStatementIds = [policy.sourceStatementIds[0]!];
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, closureHints(data));
    expect(resolved.readiness.blockingCodes).toContain("invalid_default_discovery_binding");
  });

  it("snapshots returned default provenance against later caller mutations", () => {
    const data = fixture();
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, closureHints(data));
    expect(resolved.readiness.status).toBe("mechanically_closed");
    const provenance = structuredClone(resolved.acceptedInterpretations);
    const ir = structuredClone(resolved.mechanicsIR);
    const policy = data.draft.interpretations[2]!;
    policy.review!.reason = "caller mutation";
    policy.review!.reviewEvidenceStatementIds!.length = 0;
    policy.claim.evidenceRefs.length = 0;
    policy.sourceStatementIds.length = 0;
    const spec = policy.claim.value;
    if (!spec || spec.kind !== "discovery_method") throw new Error("fixture requires discovery");
    spec.onSuccess.length = 0;
    expect(resolved.acceptedInterpretations).toEqual(provenance);
    expect(resolved.mechanicsIR).toEqual(ir);
  });

  for (const fault of ["review", "policy", "derivation", "domain", "path", "status", "schema", "evidence", "scope"] as const) {
    it(`audits substituted defaults: ${fault}`, () => {
      const data = fixture();
      const policy = data.draft.interpretations[0]!;
      if (fault === "review") policy.review!.reviewerKind = "human";
      if (fault === "policy") policy.review!.policyId = "unapproved";
      if (fault === "derivation") policy.claim.derivation = "explicit";
      if (fault === "domain") policy.claim.domain = "plot_fact";
      if (fault === "path") policy.claim.path = "not-mechanics";
      if (fault === "status") policy.interpretationStatus = "candidate";
      if (fault === "schema") (policy.claim.value as { onSuccess: unknown[] }).onSuccess = [];
      if (fault === "evidence") policy.review!.reviewEvidenceStatementIds = [];
      if (fault === "scope") policy.claim.scope.moduleId = "foreign";
      const reasons = {
        review: "approved policy review", policy: "not allowed", derivation: "must be a default",
        domain: "not a gameplay mechanic", path: "mechanics claim path", status: "not accepted",
        schema: "non-empty effects", evidence: "review evidence is required", scope: "outside module",
      };
      expect(() => resolveDraftModule(data.graph, data.draft, data.queue, closureHints(data))).toThrow(reasons[fault]);
    });
  }

  for (const role of ["name", "body"] as const) {
    it(`rejects genuine but unrelated default ${role} statements with rebuilt queue`, () => {
      const data = fixture();
      const parent = data.draft.clueCandidates[0]!;
      const child = data.draft.clueCandidates[1]!;
      const id = role === "name" ? data.draft.sceneCandidates.find((scene) => scene.id === parent.sceneCandidateId)!.headingStatementId : child.bodyStatementId!;
      if (role === "name") parent.nameStatementId = id;
      else parent.bodyStatementId = id;
      const policy = data.draft.interpretations[0]!;
      if (!policy.sourceStatementIds.includes(id)) policy.sourceStatementIds.push(id);
      const evidence = data.graph.statements.find((statement) => statement.id === id)!.evidenceRefId;
      if (!policy.claim.evidenceRefs.includes(evidence)) policy.claim.evidenceRefs.push(evidence);
      if (role === "body") {
        expect(() => buildCompilerQuestionQueue(data.graph, data.draft)).toThrow("canonical marked clue heading scope");
        return;
      }
      data.queue = buildCompilerQuestionQueue(data.graph, data.draft);
      data.draft.readiness.questionQueueHash = data.queue.queueHash;
      const resolved = resolveDraftModule(data.graph, data.draft, data.queue, closureHints(data));
      expect(resolved.readiness.blockingCodes).toContain("invalid_default_discovery_binding");
      expect(resolved.mechanicsIR).toBeUndefined();
    });
  }

  it("does not lend removed default locations to unrelated explicit provenance", () => {
    const data = fixture();
    const extra = structuredClone(data.draft.interpretations[1]!);
    extra.id = "explicit:alternative-child";
    extra.review!.interpretationId = extra.id;
    extra.review!.reviewerKind = "human";
    extra.claim.authority = "module_explicit";
    extra.claim.derivation = "explicit";
    (extra.claim.value as { id: string }).id = (data.draft.interpretations[0]!.claim.value as { id: string }).id;
    extra.claim.path = `mechanics.discovery_method.${(extra.claim.value as { id: string }).id}`;
    data.draft.interpretations.push(extra);
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, closureHints(data));
    expect(resolved.readiness.blockingCodes).toContain("missing_verified_discovery_location");
    expect(resolved.analysisInput).toBeUndefined();
  });

  it("requires playable explicit locations independently of clue targets", () => {
    const data = fixture();
    const hints = closureHints(data);
    const child = data.draft.clueCandidates[1]!;
    const answer = hints.resolutions.find((answer) => answer.kind === "discovery_method" && (answer.value as { clueCandidateId: string }).clueCandidateId === child.id)!;
    const value = answer.value as { spec: { target: string; targetId: string; onSuccess: unknown[]; failback: { effects: unknown[] } } };
    value.spec.target = "clue";
    value.spec.targetId = child.id;
    expect(resolveDraftModule(data.graph, data.draft, data.queue, hints).readiness.status).toBe("mechanically_closed");
    for (const answer of hints.resolutions) {
      const question = data.queue.questions.find((question) => question.id === answer.questionId)!;
      if (question.kind === "scene_role" && question.subjectCandidateId === child.sceneCandidateId) answer.value = { role: "rules_section" };
      if (question.kind === "connection_topology") {
        const value = answer.value as { connections: { toSceneCandidateId: string }[] };
        value.connections = question.subjectCandidateId === child.sceneCandidateId ? [] : value.connections.filter((edge) => edge.toSceneCandidateId !== child.sceneCandidateId);
      }
    }
    value.spec.onSuccess = [{ kind: "discover_clue", clueId: child.id }];
    value.spec.failback.effects = [{ kind: "discover_clue", clueId: child.id }];
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, hints);
    expect(resolved.readiness.blockingCodes).toContain("invalid_scene_resolution");
    expect(resolved.mechanicsIR).toBeUndefined();
    expect(resolved.analysisInput).toBeUndefined();
  });

  it("resolves one real queue into multiple edges, explicit zero edges, discovery replacement, and two reachable ending declarations", () => {
    const data = fixture();
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, closureHints(data));
    expect(resolved.readiness.status).toBe("mechanically_closed");
    expect(resolved.resolvedQueue.queueHash).not.toBe(data.queue.queueHash);
    expect(resolved.readiness.questionQueueHash).toBe(resolved.resolvedQueue.queueHash);
    expect(resolved.readiness.publishBlockingQuestionIds).toEqual([]);
    expect(resolved.readiness.openQuestionIds.every((id) => resolved.resolvedQueue.questions.find((question) => question.id === id)?.status === "open")).toBe(true);
    const exitClue = data.draft.clueCandidates.find((candidate) => candidate.displayName === "出口说明")!;
    const exitCore = resolved.resolvedQueue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === exitClue.id)!;
    expect(exitCore).toMatchObject({ severity: "draft_warning", status: "open" });
    expect(exitCore.resolution).toBeUndefined();
    expect(resolved.analysisInput?.coreClueIds).toEqual([data.draft.clueCandidates.find((candidate) => candidate.displayName === "子线索")!.id]);
    expect(resolved.mechanicsIR?.connections.map((connection) => connection.connectionId)).toEqual([
      "connection_archive_entry", "connection_archive_exit", "connection_entry_archive", "connection_entry_exit",
    ]);
    expect(resolved.mechanicsIR?.endings.map((ending) => [ending.id, ending.effects.find((effect) => effect.kind === "end_game")?.endingId])).toEqual([
      ["rule_clean_escape", "ending_clean_escape"],
      ["rule_hasty_exit", "ending_hasty_exit"],
    ]);
    expect(resolved.substitutedEnginePolicyInterpretationIds.length).toBe(2);
    expect(resolved.acceptedInterpretations.some((candidate) => candidate.claim.authority === "engine_policy" && (candidate.claim.value as { clueId?: string }).clueId === exitClue.id)).toBe(true);
    expect(resolved.reachabilityReport?.selectedTerminalEndingIds).toEqual(["ending_clean_escape", "ending_hasty_exit"]);
    expect(resolved.reachabilityReport?.endingWitnesses.ending_clean_escape?.steps.map((step) => step.mechanismId)).toEqual([
      "discover_parent_explicit", "hint_connection_connection_entry_archive", "discover_child_checked", "hint_connection_connection_archive_exit", "rule_clean_escape",
    ]);
    expect(resolved.reachabilityReport?.coreClueWitnesses[data.draft.clueCandidates.find((candidate) => candidate.displayName === "子线索")!.id]?.steps.map((step) => step.mechanismId)).toEqual([
      "discover_parent_explicit", "hint_connection_connection_entry_archive", "discover_child_checked",
    ]);
    expect(resolved.reachabilityReport?.failbackWitnesses.discover_child_checked?.steps.slice(-3).map((step) => step.outcome)).toEqual(["failure", "failure", "failback"]);
  });

  it("rejects an ending declaration whose mechanism ID collapses into its ending ID", () => {
    const data = fixture();
    const question = data.queue.questions.find((question) => question.kind === "ending_rule")!;
    const sceneId = data.draft.sceneCandidates[0]!.id;
    expect(() => parseCompilerHintValue(question, { declarations: [{
      endingId: "ending_same",
      spec: {
        kind: "ending_rule", id: "ending_same", priority: 1,
        when: { kind: "scene_visited", sceneId },
        effects: [{ kind: "end_game", endingId: "ending_same" }],
      },
    }] })).toThrow("must differ");
  });

  it("materializes an own location for an explicit __proto__ discovery method", () => {
    const data = fixture();
    const hints = closureHints(data);
    const parent = data.draft.clueCandidates.find((candidate) => candidate.displayName === "父线索")!;
    const question = data.queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === parent.id)!;
    const answer = hints.resolutions.find((resolution) => resolution.questionId === question.id)!;
    (answer.value as { spec: { id: string } }).spec.id = "__proto__";
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, hints);
    expect(resolved.readiness.status).toBe("mechanically_closed");
    expect(Object.hasOwn(resolved.analysisInput!.discoveryLocations, "__proto__")).toBe(true);
    expect(resolved.analysisInput!.discoveryLocations["__proto__"]).toBe(parent.sceneCandidateId);
    expect(resolved.reachabilityReport!.coreClueWitnesses[data.draft.clueCandidates.find((candidate) => candidate.displayName === "子线索")!.id]!.steps[0]!.mechanismId).toBe("__proto__");
  });

  it("keeps a partial hint set draft_only when its explicit entry answer is absent", () => {
    const data = fixture();
    const hints = closureHints(data);
    const entryQuestion = data.queue.questions.find((question) => question.kind === "entry_scene")!;
    hints.resolutions = hints.resolutions.filter((resolution) => resolution.questionId !== entryQuestion.id);
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, hints);
    expect(resolved.readiness.status).toBe("draft_only");
    expect(resolved.readiness.publishBlockingQuestionIds).toContain(entryQuestion.id);
    expect(resolved.readiness.blockingCodes).toContain("missing_entry_scene");
    expect(resolved.mechanicsIR).toBeUndefined();
  });

  it("does not treat an omitted discovery location as the mechanics target, and does not let source disposition bind a clue", () => {
    const data = fixture();
    const clue = data.draft.clueCandidates[0]!;
    const specific = data.queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === clue.id)!;
    const prose = data.queue.questions.find((question) => question.kind === "source_fact_disposition")!;
    expect(() => parseCompilerHintValue(specific, { clueCandidateId: clue.id, spec: {
      kind: "discovery_method", id: "missing_location", clueId: clue.id, action: "search", target: "scene", targetId: clue.sceneCandidateId,
      onSuccess: [{ kind: "discover_clue", clueId: clue.id }],
    } })).toThrow("location");
    expect(() => parseCompilerHintValue(prose, { clueCandidateId: clue.id, locationSceneCandidateId: clue.sceneCandidateId, spec: {
      kind: "discovery_method", id: "prose_cannot_bind", clueId: clue.id, action: "search", target: "scene", targetId: clue.sceneCandidateId,
      onSuccess: [{ kind: "discover_clue", clueId: clue.id }],
    } })).toThrow("undeclared");
  });

  it("fails closed for cross-module and duplicate topology declarations without manufacturing a second topology question", () => {
    const data = fixture();
    const hints = closureHints(data);
    const wrongModule = structuredClone(hints);
    wrongModule.moduleId = "another-module";
    expect(() => resolveDraftModule(data.graph, data.draft, data.queue, wrongModule)).toThrow("identity");
    const duplicate = structuredClone(hints);
    const entry = data.draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith("入口"))!;
    const archive = data.draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith("档案室"))!;
    const archiveTopology = data.queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === archive.id)!;
    const answer = duplicate.resolutions.find((candidate) => candidate.questionId === archiveTopology.id)!;
    answer.value = { connections: [{ toSceneCandidateId: entry.id, connectionId: "connection_entry_archive" }] };
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, duplicate);
    expect(resolved.readiness.status).toBe("draft_only");
    expect(resolved.readiness.blockingCodes).toContain("duplicate_connection_declaration");
    expect(resolved.mechanicsIR).toBeUndefined();
  });

  it("derives default discovery location from its real heading scope and retains a different-heading policy", () => {
    const data = fixture();
    const parent = data.draft.clueCandidates.find((candidate) => candidate.displayName === "父线索")!;
    const exitClue = data.draft.clueCandidates.find((candidate) => candidate.displayName === "出口说明")!;
    const entry = data.draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith("入口"))!;
    const exit = data.draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith("出口"))!;
    const parentPolicy = data.draft.interpretations.find((candidate) => (candidate.claim.value as { clueId?: string }).clueId === parent.id)!;
    const exitPolicy = data.draft.interpretations.find((candidate) => (candidate.claim.value as { clueId?: string }).clueId === exitClue.id)!;
    const resolved = resolveDraftModule(data.graph, data.draft, data.queue, closureHints(data));
    const parentMethodId = (parentPolicy.claim.value as { id: string }).id;
    const exitMethodId = (exitPolicy.claim.value as { id: string }).id;
    expect(resolved.substitutedEnginePolicyInterpretationIds).toContain(parentPolicy.id);
    expect(resolved.substitutedEnginePolicyInterpretationIds).not.toContain(exitPolicy.id);
    expect(resolved.analysisInput?.discoveryLocations[exitMethodId]).toBe(exit.id);
    expect(exitPolicy.sourceStatementIds).toContain(exit.headingStatementId);
    expect(resolved.analysisInput?.discoveryLocations[parentMethodId]).toBeUndefined();
    expect(parentPolicy.sourceStatementIds).toContain(entry.headingStatementId);
  });

  it("fails closed instead of using a default policy target as a heading-location fallback", () => {
    const data = fixture();
    const parent = data.draft.clueCandidates.find((candidate) => candidate.displayName === "父线索")!;
    const archive = data.draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith("档案室"))!;
    const policy = structuredClone(data.draft.interpretations.find((candidate) => (candidate.claim.value as { clueId?: string }).clueId === parent.id)!);
    (policy.claim.value as { targetId: string }).targetId = archive.id;
    const draft = { ...data.draft, interpretations: data.draft.interpretations.map((candidate) => candidate.id === policy.id ? policy : candidate) };
    const resolved = resolveDraftModule(data.graph, draft, data.queue, closureHints(data));
    expect(resolved.readiness.status).toBe("draft_only");
    expect(resolved.readiness.blockingCodes).toContain("invalid_default_discovery_binding");
  });

  it("fails closed when a default policy retains its identity but loses its verified heading source", () => {
    const data = fixture();
    const parent = data.draft.clueCandidates.find((candidate) => candidate.displayName === "父线索")!;
    const policy = structuredClone(data.draft.interpretations.find((candidate) => (candidate.claim.value as { clueId?: string }).clueId === parent.id)!);
    policy.sourceStatementIds = policy.sourceStatementIds.filter((id) => id !== data.draft.sceneCandidates.find((scene) => scene.id === parent.sceneCandidateId)!.headingStatementId);
    policy.review!.reviewEvidenceStatementIds = policy.review!.reviewEvidenceStatementIds!.filter((id) => policy.sourceStatementIds.includes(id));
    const draft = { ...data.draft, interpretations: data.draft.interpretations.map((candidate) => candidate.id === policy.id ? policy : candidate) };
    const resolved = resolveDraftModule(data.graph, draft, data.queue, closureHints(data));
    expect(resolved.readiness.status).toBe("draft_only");
    expect(resolved.readiness.blockingCodes).toContain("invalid_default_discovery_binding");
  });
});
