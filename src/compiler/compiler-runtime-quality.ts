import type { ResolvedCompilerArtifactPayload } from "./compiler-artifact";
import { validateMechanicsAnalysisInput } from "./mechanics-execution";
import type { MechanicsAnalysisIssue } from "./mechanics-reachability";
import {
  publicSourceFactDispositionAggregate,
  type PublicSourceFactDispositionAggregate,
  validateSourceFactDispositionReport,
} from "./source-fact-disposition";

/**
 * Aggregate-only runtime breadth facts for an already canonical resolved
 * artifact. This is intentionally not a readiness or publication verdict:
 * source-only decisions and empty runtime bindings remain valid facts.
 */
export interface CompilerRuntimeQualitySummary {
  sourceRootDisposition: PublicSourceFactDispositionAggregate;
  coverage: CompilerRuntimeCoverage;
  closedWorldIssueCounts: ClosedWorldIssueCounts;
}

/** Counts describe candidate-to-runtime breadth; they never identify a source fact or mechanism. */
export interface CompilerRuntimeCoverage {
  sceneCandidates: number;
  playableScenes: number;
  clueCandidates: number;
  /** Human-reviewed NPC relationship facts compiled as independent prose clues. */
  proseDialogueClues: number;
  /** Server-derived single-check ordinary-prose findings, always optional. */
  proseFactFindingClues: number;
  compiledClues: number;
  discoveryMethods: number;
  itemCandidates: number;
  boundItems: number;
  runtimeItems: number;
  proseNpcAnchors: number;
  boundNpcAnchors: number;
  boundNpcs: number;
  dialogueMethods: number;
  encounters: number;
  rewardCandidates: number;
  boundRewards: number;
  runtimeRewards: number;
  declaredEndings: number;
  reachableEndings: number;
}

const CLOSED_WORLD_ISSUE_CODES = [
  "unreachable_core_clue",
  "unreachable_ending",
  "core_clue_failure_policy_risk",
  "closed_world_deadlock",
] as const satisfies readonly MechanicsAnalysisIssue["code"][];

export type ClosedWorldIssueCode = typeof CLOSED_WORLD_ISSUE_CODES[number];
export type ClosedWorldIssueCounts = Record<ClosedWorldIssueCode, number>;

function failClosed(message: string): never {
  throw new Error(`invalid canonical runtime quality input: ${message}`);
}

function uniqueStrings(values: readonly string[], label: string): number {
  if (values.some((value) => typeof value !== "string" || !value)) failClosed(`${label} must be nonempty strings`);
  if (new Set(values).size !== values.length) failClosed(`${label} must be unique`);
  return values.length;
}

function uniqueObjectIds(values: readonly { id: string }[], label: string): number {
  return uniqueStrings(values.map((value) => value.id), label);
}

function assertSubset(values: readonly string[], allowed: ReadonlySet<string>, label: string): void {
  if (values.some((value) => !allowed.has(value))) failClosed(`${label} escapes its canonical candidate domain`);
}

function assertSameIds(values: readonly string[], expected: readonly string[], label: string): void {
  const valueIds = new Set(values);
  const expectedIds = new Set(expected);
  if (valueIds.size !== expectedIds.size || [...valueIds].some((id) => !expectedIds.has(id))) {
    failClosed(`${label} do not match their canonical runtime domain`);
  }
}

function assertAtMost(actual: number, maximum: number, label: string): void {
  if (actual > maximum) failClosed(`${label} exceeds its canonical domain`);
}

function sourceRootDisposition(payload: ResolvedCompilerArtifactPayload): PublicSourceFactDispositionAggregate {
  validateSourceFactDispositionReport(payload.graph, payload.resolvedSourceFactDispositionReport);
  const aggregate = publicSourceFactDispositionAggregate(payload.resolvedSourceFactDispositionReport);
  const countTotal = Object.values(aggregate.counts).reduce((total, count) => {
    if (!Number.isSafeInteger(count) || count < 0) failClosed("source root disposition count is invalid");
    return total + count;
  }, 0);
  if (countTotal !== aggregate.rootStatementCount) failClosed("source root disposition counts do not cover the roots");
  if (!Number.isSafeInteger(aggregate.rootStatementCount) || !Number.isSafeInteger(aggregate.openQuestionCount) || !Number.isSafeInteger(aggregate.openRootCount)
    || aggregate.rootStatementCount < 0 || aggregate.openQuestionCount < 0 || aggregate.openRootCount < 0 || aggregate.openRootCount > aggregate.rootStatementCount) {
    failClosed("source root disposition aggregate is impossible");
  }
  return aggregate;
}

function coverage(payload: ResolvedCompilerArtifactPayload): CompilerRuntimeCoverage {
  // These existing validators check the canonical closed-world IR and its
  // analysis input without replaying the compiler or runtime executor.
  validateMechanicsAnalysisInput(payload.mechanicsIR, payload.analysisInput);
  const sceneCandidates = uniqueObjectIds(payload.draft.sceneCandidates, "scene candidate ids");
  const clueCandidates = uniqueObjectIds(payload.draft.clueCandidates, "clue candidate ids");
  const itemCandidates = uniqueObjectIds(payload.draft.itemCandidates, "item candidate ids");
  const proseNpcAnchors = uniqueObjectIds(payload.draft.proseNpcAnchors, "prose NPC anchor ids");
  const rewardCandidates = uniqueObjectIds(payload.draft.rewardCandidates, "reward candidate ids");
  const candidateSceneIds = new Set(payload.draft.sceneCandidates.map((candidate) => candidate.id));
  const candidateClueIds = new Set(payload.draft.clueCandidates.map((candidate) => candidate.id));
  const candidateItemIds = new Set(payload.draft.itemCandidates.map((candidate) => candidate.id));
  const candidateNpcAnchorIds = new Set(payload.draft.proseNpcAnchors.map((anchor) => anchor.id));
  const candidateRewardIds = new Set(payload.draft.rewardCandidates.map((candidate) => candidate.id));

  const playableSceneIds = payload.mechanicsIR.symbols.sceneIds;
  const compiledClueIds = payload.mechanicsIR.symbols.clueIds;
  const runtimeItemIds = payload.mechanicsIR.symbols.itemIds;
  const runtimeNpcIds = payload.mechanicsIR.symbols.npcIds;
  const declaredEndingIds = payload.mechanicsIR.symbols.endingIds;
  const playableScenes = uniqueStrings(playableSceneIds, "playable scene ids");
  const compiledClues = uniqueStrings(compiledClueIds, "compiled clue ids");
  const runtimeItems = uniqueStrings(runtimeItemIds, "runtime item ids");
  const boundNpcs = uniqueStrings(payload.proseNpcBindings.map((binding) => binding.npcId), "bound NPC ids");
  const declaredEndings = uniqueStrings(declaredEndingIds, "declared ending ids");
  assertSubset(playableSceneIds, candidateSceneIds, "playable scenes");
  const proseDialogueClueIds = payload.proseDialogueClues.map((clue) => clue.clueId);
  const proseDialogueClues = uniqueStrings(proseDialogueClueIds, "prose dialogue clue ids");
  const proseDialogueById = new Map(payload.proseDialogueClues.map((clue) => [clue.clueId, clue]));
  if (payload.proseDialogueClues.some((clue) => !clue.questionId || !clue.claimKey || !clue.npcId || !clue.mechanismId
    || clue.relationshipStatementId !== clue.paragraphStatementId || clue.relationshipQuote !== clue.relationshipQuote.trim()
    || clue.relationshipQuote.length < 2 || clue.relationshipQuote.length > 240)) {
    failClosed("prose dialogue clue lacks its reviewed relationship identity");
  }
  const proseFactFindings = payload.sourceFactMechanicBindings.filter((binding): binding is Extract<(typeof payload.sourceFactMechanicBindings)[number], { declarationKind: "prose_fact_finding" }> => binding.declarationKind === "prose_fact_finding");
  const proseFactFindingClueIds = proseFactFindings.map((binding) => binding.clueId);
  const proseFactFindingClues = uniqueStrings(proseFactFindingClueIds, "prose fact finding clue ids");
  if (proseFactFindings.some((binding) => {
    const question = payload.resolvedQueue.questions.find((question) => question.id === binding.questionId);
    const candidate = payload.draft.proseFactFindingCandidates.find((candidate) => candidate.id === binding.candidateId);
    const atom = payload.draft.sourceFactAtoms.find((atom) => atom.id === binding.atomId);
    const root = payload.graph.statements.find((statement) => statement.id === binding.statementId);
    return !question || question.kind !== "source_fact_mechanic"
      || !candidate || !atom || !root || candidate.atomId !== atom.id || candidate.quote !== atom.quote
      || binding.quote !== atom.quote || binding.sceneCandidateId !== question.owningSceneCandidateId
      || binding.spec.action !== "search" || binding.spec.target !== "scene" || binding.spec.targetId !== binding.sceneCandidateId
      || binding.spec.check?.kind !== "attribute" || binding.spec.check.attribute !== "edu" || binding.spec.check.difficulty !== "regular"
      || binding.spec.onSuccess.length !== 1 || binding.spec.onSuccess[0]?.kind !== "discover_clue"
      || binding.spec.onSuccess[0]?.clueId !== binding.clueId || binding.spec.onFailure !== undefined || binding.spec.failback !== undefined
      || binding.evidence.length !== 1 || binding.evidence[0]?.statementId !== root.id || binding.evidence[0]?.quote !== atom.quote
      || payload.analysisInput.coreClueIds.includes(binding.clueId);
  })) failClosed("prose fact finding lacks its closed server-derived source/check/effect contract");
  const facetBindings = payload.clueFactFacetBindings;
  if (new Set(facetBindings.map((binding) => binding.clueId)).size !== facetBindings.length
    || facetBindings.some((binding) => !candidateClueIds.has(binding.clueId)
      || !binding.questionId || !binding.bodyStatementId || !binding.headingStatementId
      || binding.shellAtoms.some((atom) => !atom.quote.trim() || atom.evidence.spans.length !== 1 || atom.evidence.spans[0]?.exactText !== atom.quote)
      || binding.findings.some((finding) => !finding.clueId || !finding.methods.length
        || finding.atoms.some((atom) => !atom.quote.trim() || atom.evidence.spans.length !== 1 || atom.evidence.spans[0]?.exactText !== atom.quote)))) {
    failClosed("clue fact facets lack their source-exact shell or finding evidence");
  }
  const visibleShellIds = facetBindings
    .filter((binding) => binding.shellAtoms.length > 0 || binding.findings.length > 0)
    .map((binding) => binding.clueId);
  const findingClueIds = facetBindings.flatMap((binding) => binding.findings.map((finding) => finding.clueId));
  uniqueStrings(findingClueIds, "gated finding clue ids");
  const expectedCompiledClueIds = [...visibleShellIds, ...findingClueIds, ...proseDialogueById.keys(), ...proseFactFindingClueIds];
  assertSameIds(compiledClueIds, expectedCompiledClueIds, "compiled clues");
  assertAtMost(playableScenes, sceneCandidates, "playable scene count");
  if (compiledClues !== visibleShellIds.length + findingClueIds.length + proseDialogueClues + proseFactFindingClues) failClosed("compiled clue count does not cover visible shells, findings, and prose clues");

  const boundItemIds = payload.itemBindings.map((binding) => binding.itemId);
  const boundItems = uniqueStrings(boundItemIds, "bound item ids");
  const boundItemCandidateIds = payload.itemBindings.map((binding) => binding.itemCandidateId);
  uniqueStrings(boundItemCandidateIds, "bound item candidate ids");
  assertSubset(boundItemCandidateIds, candidateItemIds, "bound items");
  assertSubset(runtimeItemIds, new Set(boundItemIds), "runtime items");
  if (runtimeItems !== boundItems) failClosed("runtime items do not match bound items");
  assertSameIds(runtimeItemIds, boundItemIds, "runtime items");
  assertAtMost(boundItems, itemCandidates, "bound item count");

  const boundNpcAnchorIds = payload.proseNpcBindings.map((binding) => binding.proseAnchorId);
  const boundNpcAnchors = uniqueStrings([...new Set(boundNpcAnchorIds)], "bound NPC anchor ids");
  assertSubset(boundNpcAnchorIds, candidateNpcAnchorIds, "bound NPC anchors");
  assertAtMost(boundNpcAnchors, proseNpcAnchors, "bound NPC anchor count");
  if (uniqueStrings(runtimeNpcIds, "runtime NPC ids") !== boundNpcs) failClosed("runtime NPCs do not match bound NPCs");
  assertSameIds(runtimeNpcIds, payload.proseNpcBindings.map((binding) => binding.npcId), "runtime NPCs");

  const dialogueMethodIds = payload.proseNpcBindings.flatMap((binding) => binding.dialogueMethods.map((method) => method.mechanismId));
  const dialogueMethods = uniqueStrings(dialogueMethodIds, "NPC dialogue method ids");
  const runtimeDiscoveryMethodIds = payload.mechanicsIR.discoveryMethods.map((method) => method.id);
  const discoveryMethods = uniqueStrings(runtimeDiscoveryMethodIds, "runtime discovery method ids");
  assertSubset(dialogueMethodIds, new Set(runtimeDiscoveryMethodIds), "NPC dialogue methods");
  assertSameIds(
    dialogueMethodIds,
    payload.mechanicsIR.discoveryMethods.filter((method) => method.action === "talk" && method.target === "npc").map((method) => method.id),
    "NPC dialogue methods",
  );
  const boundEncounterCount = payload.proseNpcBindings.filter((binding) => binding.encounter !== undefined).length;
  const encounters = uniqueObjectIds(payload.mechanicsIR.encounterDefinitions, "runtime encounter ids");
  if (encounters !== boundEncounterCount) failClosed("runtime encounters do not match bound NPC encounters");
  assertSameIds(
    payload.mechanicsIR.encounterDefinitions.map((encounter) => encounter.encounterId),
    payload.proseNpcBindings.flatMap((binding) => binding.encounter ? [binding.encounter.encounterId] : []),
    "runtime encounters",
  );
  assertAtMost(encounters, boundNpcs, "runtime encounter count");

  const boundRewardCandidateIds = payload.rewardBindings
    .filter((binding) => binding.declaration !== null)
    .map((binding) => binding.rewardCandidateId);
  const boundRewards = uniqueStrings(boundRewardCandidateIds, "bound reward candidate ids");
  const allRewardBindingCandidateIds = payload.rewardBindings.map((binding) => binding.rewardCandidateId);
  uniqueStrings(allRewardBindingCandidateIds, "reward binding candidate ids");
  assertSubset(allRewardBindingCandidateIds, candidateRewardIds, "reward bindings");
  assertAtMost(allRewardBindingCandidateIds.length, rewardCandidates, "reward binding count");
  const runtimeRewards = uniqueObjectIds(payload.mechanicsIR.rewards, "runtime reward ids");
  if (runtimeRewards !== boundRewards) failClosed("runtime rewards do not match bound rewards");
  assertSameIds(payload.mechanicsIR.rewards.map((reward) => reward.id), boundRewardCandidateIds, "runtime rewards");
  assertAtMost(boundRewards, rewardCandidates, "bound reward count");

  const endingIds = payload.mechanicsIR.endings.map((ending) => {
    const endGames = ending.effects.filter((effect) => effect.kind === "end_game");
    if (endGames.length !== 1) failClosed("ending rule does not have exactly one ending");
    return endGames[0]!.endingId;
  });
  uniqueStrings(endingIds, "ending ids");
  assertSameIds(endingIds, declaredEndingIds, "ending rules");
  const reachableEndingIds = payload.reachabilityReport.reachableEndingIds;
  const reachableEndings = uniqueStrings(reachableEndingIds, "reachable ending ids");
  assertSubset(reachableEndingIds, new Set(declaredEndingIds), "reachable endings");
  assertAtMost(reachableEndings, declaredEndings, "reachable ending count");

  return {
    sceneCandidates,
    playableScenes,
    clueCandidates,
    proseDialogueClues,
    proseFactFindingClues,
    compiledClues,
    discoveryMethods,
    itemCandidates,
    boundItems,
    runtimeItems,
    proseNpcAnchors,
    boundNpcAnchors,
    boundNpcs,
    dialogueMethods,
    encounters,
    rewardCandidates,
    boundRewards,
    runtimeRewards,
    declaredEndings,
    reachableEndings,
  };
}

function closedWorldIssueCounts(payload: ResolvedCompilerArtifactPayload): ClosedWorldIssueCounts {
  const counts = Object.fromEntries(CLOSED_WORLD_ISSUE_CODES.map((code) => [code, 0])) as ClosedWorldIssueCounts;
  for (const issue of payload.reachabilityReport.issues) {
    if (!(CLOSED_WORLD_ISSUE_CODES as readonly string[]).includes(issue.code)) failClosed("unknown closed-world issue code");
    counts[issue.code]++;
  }
  if (Object.values(counts).reduce((total, count) => total + count, 0) !== payload.reachabilityReport.issues.length) {
    failClosed("closed-world issue counts do not cover the report");
  }
  return counts;
}

/** Derive JSON-safe aggregate facts without replaying compiler or runtime execution. */
export function summarizeCompilerRuntimeQuality(payload: ResolvedCompilerArtifactPayload): CompilerRuntimeQualitySummary {
  return {
    sourceRootDisposition: sourceRootDisposition(payload),
    coverage: coverage(payload),
    closedWorldIssueCounts: closedWorldIssueCounts(payload),
  };
}
