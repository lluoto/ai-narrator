import type { Effect, MechanicsIR, Predicate, RewardPredicate } from "./mechanics-ir";
import {
  applyPlayerMechanicsEffects,
  availableMechanicsPlayerActions,
  createMechanicsEdge,
  createMechanicsStateBudget,
  executeMechanicsAction,
  initialMechanicsState,
  mechanicsStateHash,
  matchesMechanicsPredicate,
  MechanicsReachabilityError,
  settleAutomaticMechanics,
  settleInitialMechanics,
  nextAutomaticMechanicsStep,
  validateMechanicsAnalysisInput,
  type MechanicsAnalysisInput,
  type MechanicsCombatOutcome,
  type MechanicsOutcome,
  type MechanicsReachabilityEdge,
  type MechanicsState,
  type MechanicsStateBudget,
} from "./mechanics-execution";

export {
  MechanicsReachabilityError,
  mechanicsStateHash,
  validateMechanicsAnalysisInput,
} from "./mechanics-execution";
export type {
  MechanicsAnalysisInput,
  MechanicsCombatOutcome,
  MechanicsOutcome,
  MechanicsReachabilityEdge,
  MechanicsState,
} from "./mechanics-execution";

export interface MechanicsWitness {
  startSceneId: string;
  steps: MechanicsReachabilityEdge[];
  final: { kind: "clue" | "ending" | "loss" | "deadlock"; id: string; stateHash: string };
}

export interface MechanicsAnalysisIssue {
  code: "unreachable_core_clue" | "unreachable_ending" | "core_clue_failure_policy_risk" | "closed_world_deadlock";
  id: string;
  witness?: MechanicsWitness;
}

export interface MechanicsReachabilityReport {
  /**
   * Number of bounded control-equivalence classes explored, not the Cartesian
   * count of complete MechanicsState combinations. Edges and witnesses retain
   * complete mechanicsStateHash values for shared executor replay.
   */
  reachableStateCount: number;
  reachableClueIds: string[];
  unreachableCoreClueIds: string[];
  reachableEndingIds: string[];
  unreachableEndingIds: string[];
  selectedTerminalEndingIds: string[];
  endingWitnesses: Record<string, MechanicsWitness>;
  /** Losses are terminal witnesses, never synthetic endings or deadlocks. */
  terminalLossWitnesses: Record<string, MechanicsWitness>;
  coreClueWitnesses: Record<string, MechanicsWitness>;
  failbackWitnesses: Record<string, MechanicsWitness>;
  deadlockWitnesses: MechanicsWitness[];
  failurePolicyRiskMethodIds: string[];
  failureDeadlockWitnesses: Record<string, MechanicsWitness>;
  /**
   * Every edge is directly executable and retains complete before/after
   * mechanicsStateHash values. The collection covers control-equivalence
   * representatives only, not a complete full-hash adjacency graph.
   */
  edges: MechanicsReachabilityEdge[];
  issues: MechanicsAnalysisIssue[];
  analysisScope: "closed_world";
}

/**
 * `hash` is always a complete mechanicsStateHash that can be replayed.  The
 * analyzer uses `controlKey` only to choose an equivalent representative.
 */
interface SearchNode { state: MechanicsState; hash: string; controlKey: string; steps: MechanicsReachabilityEdge[]; }

function assertNever(value: never): never {
  throw new MechanicsReachabilityError("invalid_predicate", `unsupported predicate in control relevance: ${JSON.stringify(value)}`);
}

function collectPredicateClueIds(predicate: Predicate | RewardPredicate, clueIds: Set<string>): void {
  switch (predicate.kind) {
    case "all":
    case "any":
      predicate.predicates.forEach((entry) => collectPredicateClueIds(entry, clueIds));
      return;
    case "not":
      collectPredicateClueIds(predicate.predicate, clueIds);
      return;
    case "clue_found":
      clueIds.add(predicate.clueId);
      return;
    case "scene_visited":
    case "current_scene":
    case "item_owned":
    case "connection_unlocked":
    case "state_eq":
    case "npc_state":
    case "encounter_defeated":
      return;
    default:
      return assertNever(predicate);
  }
}

function discoveredClueIds(effects: readonly Effect[]): string[] {
  return effects.flatMap((effect) => effect.kind === "discover_clue" ? [effect.clueId] : []);
}

/**
 * A clue may leave the control state only when every way of discovering it is
 * an otherwise-effect-free discovery of that same clue.  This is deliberately
 * conservative: it retains source facts used by any decision predicate and
 * every branch with a recovery or secondary effect.
 */
function collapsibleObservationClueIds(ir: MechanicsIR, coreClueIds: readonly string[]): Set<string> {
  const referenced = new Set<string>();
  for (const discovery of ir.discoveryMethods) if (discovery.availability) collectPredicateClueIds(discovery.availability, referenced);
  for (const connection of ir.connections) if (connection.availability) collectPredicateClueIds(connection.availability, referenced);
  for (const transition of ir.transitions) collectPredicateClueIds(transition.when, referenced);
  for (const ending of ir.endings) collectPredicateClueIds(ending.when, referenced);
  for (const reward of ir.rewards) collectPredicateClueIds(reward.when, referenced);

  const methodsByClue = new Map<string, MechanicsIR["discoveryMethods"]>();
  const externallyDiscovered = new Set<string>();
  for (const discovery of ir.discoveryMethods) {
    const methods = methodsByClue.get(discovery.clueId) ?? [];
    methods.push(discovery);
    methodsByClue.set(discovery.clueId, methods);
    for (const clueId of discoveredClueIds(discovery.onSuccess)) if (clueId !== discovery.clueId) externallyDiscovered.add(clueId);
    for (const clueId of discoveredClueIds(discovery.onFailure ?? [])) externallyDiscovered.add(clueId);
    for (const clueId of discoveredClueIds(discovery.failback?.effects ?? [])) externallyDiscovered.add(clueId);
  }
  for (const effects of [
    ...ir.connections.map((connection) => connection.onTraverse ?? []),
    ...ir.transitions.map((transition) => transition.effects),
    ...ir.endings.map((ending) => ending.effects),
    ...ir.encounterDefinitions.map((encounter) => encounter.victoryEffects),
  ]) for (const clueId of discoveredClueIds(effects)) externallyDiscovered.add(clueId);

  const collapsible = new Set<string>();
  for (const clueId of ir.symbols.clueIds) {
    const methods = methodsByClue.get(clueId) ?? [];
    if (coreClueIds.includes(clueId) || referenced.has(clueId) || externallyDiscovered.has(clueId) || methods.length === 0) continue;
    if (methods.every((method) => method.onSuccess.length === 1
      && method.onSuccess[0]?.kind === "discover_clue"
      && method.onSuccess[0].clueId === clueId
      && method.onFailure === undefined
      && method.failback === undefined)) {
      collapsible.add(clueId);
    }
  }
  return collapsible;
}

function mechanicsControlStateKey(state: MechanicsState, collapsibleClueIds: ReadonlySet<string>): string {
  return `control:${mechanicsStateHash({ ...state, foundClueIds: state.foundClueIds.filter((clueId) => !collapsibleClueIds.has(clueId)) })}`;
}

/**
 * Search quota intentionally counts control equivalence classes, but the
 * returned hash stays complete so automatic-cycle detection and all witnesses
 * retain shared executor/replay semantics.
 */
function createControlStateBudget(maxStates: number, controlKeyForState: (state: MechanicsState) => string): MechanicsStateBudget {
  const controlKeys = new Set<string>();
  const budget: MechanicsStateBudget = {
    get count() { return controlKeys.size; },
    observe(state) {
      const hash = mechanicsStateHash(state);
      const controlKey = controlKeyForState(state);
      if (!controlKeys.has(controlKey)) {
        if (controlKeys.size >= maxStates) throw new MechanicsReachabilityError("state_limit_exceeded", `state limit exceeded: ${maxStates}`);
        controlKeys.add(controlKey);
      }
      return hash;
    },
  };
  return Object.freeze(budget);
}

function hasBoundedRecoveryFromFailure(ir: MechanicsIR, input: MechanicsAnalysisInput, riskyMethodId: string, failedState: MechanicsState, controlKeyForState: (state: MechanicsState) => string): boolean {
  const risky = ir.discoveryMethods.find((method) => method.id === riskyMethodId)!;
  const unsafe = new Set(ir.discoveryMethods.filter((method) => method.check !== undefined && method.check.kind !== "none" && !method.failback).map((method) => method.id));
  const budget = createControlStateBudget(input.maxStates, controlKeyForState);
  const initial = settleAutomaticMechanics(ir, failedState, budget);
  if (initial.states.some((entry) => entry.state.foundClueIds.includes(risky.clueId))) return true;
  if (initial.state.terminalEndingId || initial.state.terminalLoss) return false;
  type RecoveryOutcome = { kind: "goal" | "loss" } | { kind: "state"; controlKey: string };
  type RecoveryChoice = { outcomes: RecoveryOutcome[] };
  const initialControlKey = controlKeyForState(initial.state);
  const states = new Map<string, MechanicsState>([[initialControlKey, initial.state]]);
  const choices = new Map<string, RecoveryChoice[]>();
  const queue = [initialControlKey];
  while (queue.length) {
    const controlKey = queue.shift()!;
    const state = states.get(controlKey)!;
    const actionGroups = new Map<string, ReturnType<typeof availableMechanicsPlayerActions>>();
    for (const action of availableMechanicsPlayerActions(ir, input, state)) {
      if (unsafe.has(action.mechanismId)) continue;
      const group = actionGroups.get(action.mechanismId) ?? [];
      group.push(action);
      actionGroups.set(action.mechanismId, group);
    }
    const stateChoices: RecoveryChoice[] = [];
    for (const actions of actionGroups.values()) {
      const outcomes: RecoveryOutcome[] = [];
      for (const action of actions) {
        const trace = settleAutomaticMechanics(ir, action.next, budget);
        if (trace.states.some((entry) => entry.state.foundClueIds.includes(risky.clueId))) {
          outcomes.push({ kind: "goal" });
          continue;
        }
        if (trace.state.terminalEndingId || trace.state.terminalLoss) {
          outcomes.push({ kind: "loss" });
          continue;
        }
        const nextControlKey = controlKeyForState(trace.state);
        if (!states.has(nextControlKey)) {
          states.set(nextControlKey, trace.state);
          queue.push(nextControlKey);
        }
        outcomes.push({ kind: "state", controlKey: nextControlKey });
      }
      stateChoices.push({ outcomes });
    }
    choices.set(controlKey, stateChoices);
  }
  const winning = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [controlKey, stateChoices] of choices) {
      if (winning.has(controlKey) || !stateChoices.some((choice) => choice.outcomes.every((outcome) => outcome.kind === "goal" || (outcome.kind === "state" && winning.has(outcome.controlKey))))) continue;
      winning.add(controlKey);
      changed = true;
    }
  }
  return winning.has(initialControlKey);
}

export function analyzeMechanicsReachability(ir: MechanicsIR, input: MechanicsAnalysisInput): MechanicsReachabilityReport {
  validateMechanicsAnalysisInput(ir, input);
  const collapsibleClueIds = collapsibleObservationClueIds(ir, input.coreClueIds);
  const controlKeyForState = (state: MechanicsState): string => mechanicsControlStateKey(state, collapsibleClueIds);
  const stateBudget = createControlStateBudget(input.maxStates, controlKeyForState);
  const initialTrace = settleInitialMechanics(ir, input, stateBudget);
  const allEdges: MechanicsReachabilityEdge[] = [...initialTrace.steps];
  const stateNodes = new Map<string, SearchNode>();
  const terminalControlKeys = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const reachableClues = new Set<string>();
  const reachableEndings = new Set<string>();
  const terminalEndings = new Set<string>();
  const endingWitnesses: Record<string, MechanicsWitness> = Object.create(null) as Record<string, MechanicsWitness>;
  const terminalLossWitnesses: Record<string, MechanicsWitness> = Object.create(null) as Record<string, MechanicsWitness>;
  const coreClueWitnesses: Record<string, MechanicsWitness> = Object.create(null) as Record<string, MechanicsWitness>;
  const failbackWitnesses: Record<string, MechanicsWitness> = Object.create(null) as Record<string, MechanicsWitness>;
  const failureTraces: Array<{ mechanismId: string; stateHash: string; controlKey: string; steps: MechanicsReachabilityEdge[] }> = [];
  const queue: SearchNode[] = [];
  const shorter = (candidate: MechanicsReachabilityEdge[], current: MechanicsReachabilityEdge[] | undefined): boolean => !current || candidate.length < current.length;
  const recordClues = (state: MechanicsState, steps: MechanicsReachabilityEdge[], hash: string) => {
    for (const clueId of state.foundClueIds) {
      reachableClues.add(clueId);
      if (input.coreClueIds.includes(clueId) && shorter(steps, coreClueWitnesses[clueId]?.steps)) coreClueWitnesses[clueId] = { startSceneId: input.entrySceneId, steps, final: { kind: "clue", id: clueId, stateHash: hash } };
    }
  };
  const recordTraceClues = (trace: ReturnType<typeof settleAutomaticMechanics>, prefix: MechanicsReachabilityEdge[]) => {
    for (const entry of trace.states) recordClues(entry.state, [...prefix, ...trace.steps.slice(0, entry.stepCount)], entry.hash);
  };
  const recordTerminal = (state: MechanicsState, steps: MechanicsReachabilityEdge[]) => {
    const hash = stateBudget.observe(state);
    terminalControlKeys.add(controlKeyForState(state));
    recordClues(state, steps, hash);
    if (state.terminalLoss) {
      const lossId = state.terminalLoss.encounterId;
      if (shorter(steps, terminalLossWitnesses[lossId]?.steps)) terminalLossWitnesses[lossId] = { startSceneId: input.entrySceneId, steps, final: { kind: "loss", id: lossId, stateHash: hash } };
      return;
    }
    const endingId = state.terminalEndingId!;
    reachableEndings.add(endingId);
    terminalEndings.add(endingId);
    if (shorter(steps, endingWitnesses[endingId]?.steps)) endingWitnesses[endingId] = { startSceneId: input.entrySceneId, steps, final: { kind: "ending", id: endingId, stateHash: hash } };
  };
  const registerStable = (state: MechanicsState, steps: MechanicsReachabilityEdge[]): SearchNode | undefined => {
    if (state.terminalEndingId || state.terminalLoss) { recordTerminal(state, steps); return undefined; }
    const hash = stateBudget.observe(state);
    const controlKey = controlKeyForState(state);
    recordClues(state, steps, hash);
    if (stateNodes.has(controlKey)) {
      const previous = stateNodes.get(controlKey);
      if (previous && shorter(steps, previous.steps)) {
        const replacement = { state, hash, controlKey, steps };
        stateNodes.set(controlKey, replacement);
        queue.push(replacement);
        return replacement;
      }
      return previous;
    }
    const node = { state, hash, controlKey, steps };
    stateNodes.set(controlKey, node);
    adjacency.set(controlKey, new Set());
    queue.push(node);
    return node;
  };
  recordTraceClues(initialTrace, []);
  registerStable(initialTrace.state, initialTrace.steps);
  const addAction = (node: SearchNode, mechanismId: string, outcome: MechanicsOutcome, next: MechanicsState, sourceInterpretationIds: string[], combat?: MechanicsCombatOutcome) => {
    const action = createMechanicsEdge(mechanismId, outcome, node.state, next, sourceInterpretationIds, undefined, combat);
    if (action.beforeStateHash === action.afterStateHash) return;
    const actionSteps = [...node.steps, action];
    if (outcome === "failback" && shorter(actionSteps, failbackWitnesses[mechanismId]?.steps)) {
      const discovery = ir.discoveryMethods.find((method) => method.id === mechanismId)!;
      failbackWitnesses[mechanismId] = { startSceneId: input.entrySceneId, steps: actionSteps, final: { kind: "clue", id: discovery.clueId, stateHash: action.afterStateHash } };
    }
    const trace = settleAutomaticMechanics(ir, next, stateBudget);
    const steps = [...actionSteps, ...trace.steps];
    recordTraceClues(trace, actionSteps);
    allEdges.push(action, ...trace.steps);
    const finalHash = mechanicsStateHash(trace.state);
    const finalControlKey = controlKeyForState(trace.state);
    if (outcome === "failure") failureTraces.push({ mechanismId, stateHash: finalHash, controlKey: finalControlKey, steps });
    if (trace.state.terminalEndingId || trace.state.terminalLoss) {
      if (finalControlKey !== node.controlKey) adjacency.get(node.controlKey)!.add(finalControlKey);
      recordTerminal(trace.state, steps);
      return;
    }
    if (finalControlKey === node.controlKey) return;
    adjacency.get(node.controlKey)!.add(finalControlKey);
    registerStable(trace.state, steps);
  };
  while (queue.length) {
    queue.sort((left, right) => left.steps.length - right.steps.length || left.controlKey.localeCompare(right.controlKey) || left.hash.localeCompare(right.hash));
    const node = queue.shift()!;
    if (stateNodes.get(node.controlKey) !== node) continue;
    for (const action of availableMechanicsPlayerActions(ir, input, node.state)) addAction(node, action.mechanismId, action.outcome, action.next, action.sourceInterpretationIds, action.outcome === "attack" ? action.combat : undefined);
  }
  const reverse = new Map<string, Set<string>>();
  for (const [from, tos] of adjacency) for (const to of tos) { const sources = reverse.get(to) ?? new Set<string>(); sources.add(from); reverse.set(to, sources); }
  const canReachTerminal = new Set<string>(terminalControlKeys);
  const work = [...terminalControlKeys];
  while (work.length) {
    const current = work.pop()!;
    for (const predecessor of reverse.get(current) ?? []) if (!canReachTerminal.has(predecessor)) { canReachTerminal.add(predecessor); work.push(predecessor); }
  }
  const deadlockWitnesses = [...stateNodes.values()].filter((node) => !canReachTerminal.has(node.controlKey)).sort((left, right) => left.steps.length - right.steps.length || left.hash.localeCompare(right.hash)).map((node) => ({ startSceneId: input.entrySceneId, steps: node.steps, final: { kind: "deadlock" as const, id: node.hash, stateHash: node.hash } }));
  const failureDeadlockWitnesses: Record<string, MechanicsWitness> = Object.create(null) as Record<string, MechanicsWitness>;
  for (const trace of failureTraces.filter((entry) => !canReachTerminal.has(entry.controlKey)).sort((left, right) => left.steps.length - right.steps.length || left.stateHash.localeCompare(right.stateHash) || left.mechanismId.localeCompare(right.mechanismId))) {
    if (!Object.hasOwn(failureDeadlockWitnesses, trace.mechanismId)) failureDeadlockWitnesses[trace.mechanismId] = { startSceneId: input.entrySceneId, steps: trace.steps, final: { kind: "deadlock", id: trace.stateHash, stateHash: trace.stateHash } };
  }
  const failurePolicyRiskMethodIds = ir.discoveryMethods
    .filter((method) => input.coreClueIds.includes(method.clueId) && method.check !== undefined && method.check.kind !== "none" && !method.failback)
    .filter((method) => [...stateNodes.values()].some((node) => {
      if (node.state.foundClueIds.includes(method.clueId) || input.discoveryLocations[method.id] !== node.state.currentSceneId || (method.availability && !matchesMechanicsPredicate(method.availability, node.state))) return false;
      return !hasBoundedRecoveryFromFailure(ir, input, method.id, applyPlayerMechanicsEffects(node.state, method.onFailure ?? [], "failure", [], method.actorEffectProvenance, "onFailure", ir).state, controlKeyForState);
    }))
    .map((method) => method.id)
    .sort();
  const unreachableCoreClueIds = input.coreClueIds.filter((id) => !reachableClues.has(id)).sort();
  const unreachableEndingIds = ir.symbols.endingIds.filter((id) => !reachableEndings.has(id)).sort();
  const issues: MechanicsAnalysisIssue[] = [
    ...unreachableCoreClueIds.map((id) => ({ code: "unreachable_core_clue" as const, id })),
    ...unreachableEndingIds.map((id) => ({ code: "unreachable_ending" as const, id })),
    ...failurePolicyRiskMethodIds.map((id) => ({ code: "core_clue_failure_policy_risk" as const, id })),
    ...deadlockWitnesses.map((entry) => ({ code: "closed_world_deadlock" as const, id: entry.final.stateHash, witness: entry })),
  ];
  return { reachableStateCount: stateBudget.count, reachableClueIds: [...reachableClues].sort(), unreachableCoreClueIds, reachableEndingIds: [...reachableEndings].sort(), unreachableEndingIds, selectedTerminalEndingIds: [...terminalEndings].sort(), endingWitnesses, terminalLossWitnesses, coreClueWitnesses, failbackWitnesses, deadlockWitnesses, failurePolicyRiskMethodIds, failureDeadlockWitnesses, edges: allEdges, issues, analysisScope: "closed_world" };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

function assertReplayStep(actual: MechanicsReachabilityEdge, expected: MechanicsReachabilityEdge): void {
  if (actual.mechanismId !== expected.mechanismId || !sameStrings(actual.mechanismIds, expected.mechanismIds) || actual.outcome !== expected.outcome) throw new MechanicsReachabilityError("invalid_witness_step", "witness mechanism or outcome is not executable from this state");
  if (JSON.stringify(actual.combat) !== JSON.stringify(expected.combat)) throw new MechanicsReachabilityError("invalid_witness_step", "witness combat result does not match execution");
  if (actual.beforeStateHash !== expected.beforeStateHash || actual.afterStateHash !== expected.afterStateHash) throw new MechanicsReachabilityError("invalid_witness_hash", "witness state hash does not match execution");
}

export function replayMechanicsWitness(ir: MechanicsIR, input: MechanicsAnalysisInput, witness: MechanicsWitness): MechanicsState {
  validateMechanicsAnalysisInput(ir, input);
  if (witness.startSceneId !== input.entrySceneId) throw new MechanicsReachabilityError("invalid_witness_start", "witness start scene does not match analysis input");
  let state = initialMechanicsState(input);
  const budget = createMechanicsStateBudget(input.maxStates);
  budget.observe(state);
  for (const step of witness.steps) {
    if (step.beforeStateHash !== mechanicsStateHash(state)) throw new MechanicsReachabilityError("invalid_witness_hash", "witness before-state hash does not match execution");
    if (state.terminalEndingId || state.terminalLoss) throw new MechanicsReachabilityError("invalid_witness_step", "witness continues after terminal state");
    const automatic = nextAutomaticMechanicsStep(ir, state);
    if (step.outcome === "transition" || step.outcome === "ending") {
      if (!automatic) throw new MechanicsReachabilityError("invalid_witness_step", "witness names an unavailable automatic mechanism");
      assertReplayStep(step, automatic.step);
      state = automatic.state;
      budget.observe(state);
      continue;
    }
    if (automatic) throw new MechanicsReachabilityError("invalid_witness_step", "optional action was attempted before automatic settlement");
    let executed;
    try {
      if (step.outcome === "attack") {
        if (!step.combat) throw new MechanicsReachabilityError("invalid_witness_step", "attack witness step has no combat payload");
        executed = executeMechanicsAction(ir, input, state, { mechanismId: step.mechanismId, outcome: "attack", combat: step.combat });
      } else if (step.outcome === "success" || step.outcome === "failure" || step.outcome === "failback" || step.outcome === "traverse") {
        executed = executeMechanicsAction(ir, input, state, { mechanismId: step.mechanismId, outcome: step.outcome });
      } else {
        throw new MechanicsReachabilityError("invalid_witness_step", "witness edge is not an executable player action");
      }
    } catch (error) {
      if (!(error instanceof MechanicsReachabilityError)) throw error;
      throw new MechanicsReachabilityError("invalid_witness_step", "witness action is unavailable from this state");
    }
    assertReplayStep(step, executed.edge);
    state = executed.state;
    budget.observe(state);
  }
  if (mechanicsStateHash(state) !== witness.final.stateHash) throw new MechanicsReachabilityError("invalid_witness_hash", "witness final state hash does not match execution");
  if (witness.final.kind === "clue" && !state.foundClueIds.includes(witness.final.id)) throw new MechanicsReachabilityError("invalid_witness_goal", "witness did not discover its declared clue");
  if (witness.final.kind === "ending" && state.terminalEndingId !== witness.final.id) throw new MechanicsReachabilityError("invalid_witness_goal", "witness did not reach its declared ending");
  if (witness.final.kind === "loss" && state.terminalLoss?.encounterId !== witness.final.id) throw new MechanicsReachabilityError("invalid_witness_goal", "witness did not reach its declared terminal loss");
  if (witness.final.kind === "deadlock" && (state.terminalEndingId || state.terminalLoss)) throw new MechanicsReachabilityError("invalid_witness_goal", "deadlock witness reached a terminal state");
  return state;
}
