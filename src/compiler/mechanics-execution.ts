import { validateMechanicsIR, type ActorEffectProvenance, type CombatDamageSpec, type Effect, type MechanicsIR, type Predicate, type SanityCheckEffect, type Scalar } from "./mechanics-ir";

export interface MechanicsAnalysisInput {
  entrySceneId: string;
  initialState: { foundClueIds: string[]; visitedSceneIds: string[]; ownedItemIds: string[]; stateValues: Record<string, Scalar>; npcStates: Record<string, string> };
  coreClueIds: string[];
  connections: Array<{ id: string; fromSceneId: string; toSceneId: string }>;
  discoveryLocations: Record<string, string>;
  maxStates: number;
}

export interface MechanicsState {
  currentSceneId: string;
  foundClueIds: string[];
  visitedSceneIds: string[];
  ownedItemIds: string[];
  stateValues: Record<string, Scalar>;
  npcStates: Record<string, string>;
  unlockedConnectionIds: string[];
  failureCounts: Record<string, number>;
  /** Canonical source of encounter progress; startedEncounterIds is derived compatibility data. */
  encounters: Record<string, { status: "active" | "defeated"; currentHp: number }>;
  startedEncounterIds: string[];
  rewardIds: string[];
  terminalEndingId?: string;
  /** A combat loss is terminal but is intentionally not an ending ID. */
  terminalLoss?: { kind: "encounter_defeat"; encounterId: string; combatantId: string };
}

export type MechanicsOutcome = "success" | "failure" | "failback" | "traverse" | "transition" | "ending" | "attack";
export type OrdinaryMechanicsOutcome = Exclude<MechanicsOutcome, "attack">;

/** A fully replayable, selected combat exchange; no random selection occurs in the core. */
export type MechanicsCombatOutcome =
  | { kind: "attack"; encounterId: string; targetId: string; hit: false; damage: 0; enemyHit: boolean; actorDamage: number; actorDefeated: boolean }
  | { kind: "attack"; encounterId: string; targetId: string; hit: true; damage: number; enemyHit: boolean; actorDamage: number; actorDefeated: boolean };

/** Explicit engine policy, not an authored second combat DSL. */
export const PLAYER_UNARMED_ATTACK_POLICY: CombatDamageSpec = Object.freeze({ kind: "fixed", amount: 1 });

export interface MechanicsReachabilityEdge {
  mechanismId: string;
  mechanismIds: string[];
  outcome: MechanicsOutcome;
  /** Present only on an attack edge and discriminated by its own kind. */
  combat?: MechanicsCombatOutcome;
  beforeStateHash: string;
  afterStateHash: string;
  sourceInterpretationIds: string[];
  summary: string;
}

export interface MechanicsClosureTrace {
  state: MechanicsState;
  steps: MechanicsReachabilityEdge[];
  states: Array<{ state: MechanicsState; hash: string; stepCount: number }>;
}

interface MechanicsPlayerActionBase {
  mechanismId: string;
  next: MechanicsState;
  /** Actor-only consequences selected from this exact executable branch. */
  actorEffects: SelectedActorEffect[];
  sourceInterpretationIds: string[];
}

export type MechanicsPlayerAction =
  | (MechanicsPlayerActionBase & { outcome: Extract<MechanicsOutcome, "success" | "failure" | "failback" | "traverse">; combat?: never })
  | (MechanicsPlayerActionBase & { outcome: "attack"; combat: MechanicsCombatOutcome });

export type MechanicsActionRequest =
  | { mechanismId: string; outcome: Extract<MechanicsOutcome, "success" | "failure" | "failback" | "traverse"> }
  | { mechanismId: string; outcome: "attack"; combat: MechanicsCombatOutcome };

/** One actor effect selected from a concrete branch, retaining its declaration index and provenance. */
export interface SelectedActorEffect {
  /** Branch identity disambiguates index zero across success/failure/failback. */
  outcome: "success" | "failure" | "failback" | "traverse";
  effectIndex: number;
  effectPath: string;
  effect: SanityCheckEffect;
  /** Exact source/event-slot claim selected with this effect, never node-global provenance. */
  provenance: ActorEffectProvenance;
  sourceInterpretationIds: string[];
}

export interface MechanicsStateBudget {
  readonly count: number;
  observe(state: MechanicsState): string;
}

export class MechanicsReachabilityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MechanicsReachabilityError";
  }
}

const scalar = (value: unknown): value is Scalar => value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sorted(values: Iterable<string>): string[] { return [...new Set(values)].sort(); }
function sortedRecord<T>(record: Record<string, T>): Record<string, T> { return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))); }

export function normalizeMechanicsState(state: MechanicsState): MechanicsState {
  const encounters = Object.fromEntries(Object.entries(state.encounters ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([encounterId, encounter]) => [
    encounterId,
    { status: encounter.status, currentHp: encounter.currentHp },
  ])) as MechanicsState["encounters"];
  return {
    currentSceneId: state.currentSceneId,
    foundClueIds: sorted(state.foundClueIds),
    visitedSceneIds: sorted(state.visitedSceneIds),
    ownedItemIds: sorted(state.ownedItemIds),
    stateValues: sortedRecord(state.stateValues),
    npcStates: sortedRecord(state.npcStates),
    unlockedConnectionIds: sorted(state.unlockedConnectionIds),
    failureCounts: sortedRecord(state.failureCounts),
    encounters,
    /** Compatibility view derived only from canonical encounter state. */
    startedEncounterIds: Object.keys(encounters),
    rewardIds: sorted(state.rewardIds),
    ...(state.terminalEndingId ? { terminalEndingId: state.terminalEndingId } : {}),
    ...(state.terminalLoss ? { terminalLoss: structuredClone(state.terminalLoss) } : {}),
  };
}

export function mechanicsStateHash(state: MechanicsState): string { return canonical(normalizeMechanicsState(state)); }
function requireKnown(id: string, values: readonly string[], label: string): void { if (!values.includes(id)) throw new MechanicsReachabilityError("unknown_symbol", `unknown ${label}: ${id}`); }
function requireUnique(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new MechanicsReachabilityError("duplicate_input", `duplicate ${label}`); }
function terminal(state: MechanicsState): boolean { return !!state.terminalEndingId || !!state.terminalLoss; }
function activeEncounterId(state: MechanicsState): string | undefined { return Object.entries(state.encounters).find(([, encounter]) => encounter.status === "active")?.[0]; }

export function createMechanicsStateBudget(maxStates: number): MechanicsStateBudget {
  if (!Number.isInteger(maxStates) || maxStates < 1) throw new MechanicsReachabilityError("invalid_max_states", "maxStates must be a positive integer");
  const hashes = new Set<string>();
  return Object.freeze({
    get count() { return hashes.size; },
    observe(state: MechanicsState) {
      const hash = mechanicsStateHash(state);
      if (!hashes.has(hash)) {
        if (hashes.size >= maxStates) throw new MechanicsReachabilityError("state_limit_exceeded", `state limit exceeded: ${maxStates}`);
        hashes.add(hash);
      }
      return hash;
    },
  });
}

function validateInitialState(ir: MechanicsIR, input: MechanicsAnalysisInput): void {
  const initial = input.initialState;
  const listChecks: Array<[string[], string[], string]> = [
    [initial.foundClueIds, ir.symbols.clueIds, "initial clue"],
    [initial.visitedSceneIds, ir.symbols.sceneIds, "initial scene"],
    [initial.ownedItemIds, ir.symbols.itemIds, "initial item"],
    [input.coreClueIds, ir.symbols.clueIds, "core clue"],
  ];
  for (const [ids, symbols, label] of listChecks) { requireUnique(ids, label); ids.forEach((id) => requireKnown(id, symbols, label)); }
  for (const [key, value] of Object.entries(initial.stateValues)) {
    requireKnown(key, ir.symbols.declaredStateKeys, "state key");
    if (!scalar(value)) throw new MechanicsReachabilityError("invalid_initial_state", `invalid state value: ${key}`);
  }
  for (const [npcId, state] of Object.entries(initial.npcStates)) {
    requireKnown(npcId, ir.symbols.npcIds, "npc");
    if (!state.trim()) throw new MechanicsReachabilityError("invalid_initial_state", `invalid NPC state: ${npcId}`);
  }
}

export function validateMechanicsAnalysisInput(ir: MechanicsIR, input: MechanicsAnalysisInput): void {
  validateMechanicsIR(ir);
  if (!Number.isInteger(input.maxStates) || input.maxStates < 1) throw new MechanicsReachabilityError("invalid_max_states", "maxStates must be a positive integer");
  requireKnown(input.entrySceneId, ir.symbols.sceneIds, "entry scene");
  validateInitialState(ir, input);
  const connectionIds = input.connections.map((connection) => connection.id);
  requireUnique(connectionIds, "connection input");
  for (const connection of input.connections) {
    requireKnown(connection.id, ir.symbols.connectionIds, "connection");
    requireKnown(connection.fromSceneId, ir.symbols.sceneIds, "connection source scene");
    requireKnown(connection.toSceneId, ir.symbols.sceneIds, "connection target scene");
  }
  for (const gate of ir.connections) if (!input.connections.some((connection) => connection.id === gate.connectionId)) throw new MechanicsReachabilityError("missing_connection", `connection target is missing: ${gate.connectionId}`);
  const locations = Object.keys(input.discoveryLocations);
  requireUnique(locations, "discovery location");
  for (const discovery of ir.discoveryMethods) {
    const sceneId = input.discoveryLocations[discovery.id];
    if (!sceneId) throw new MechanicsReachabilityError("missing_discovery_location", `discovery location is missing: ${discovery.id}`);
    requireKnown(sceneId, ir.symbols.sceneIds, "discovery location scene");
  }
  for (const discoveryId of locations) if (!ir.discoveryMethods.some((discovery) => discovery.id === discoveryId)) throw new MechanicsReachabilityError("unknown_discovery_location", `unknown discovery location: ${discoveryId}`);
  for (const discovery of ir.discoveryMethods) if (discovery.failback && !discovery.failback.effects.some((effect) => effect.kind === "discover_clue" && effect.clueId === discovery.clueId)) throw new MechanicsReachabilityError("invalid_failback", `failback does not discover method clue: ${discovery.id}`);
}

export function matchesMechanicsPredicate(predicate: Predicate, state: MechanicsState): boolean {
  switch (predicate.kind) {
    case "all": return predicate.predicates.every((entry) => matchesMechanicsPredicate(entry, state));
    case "any": return predicate.predicates.some((entry) => matchesMechanicsPredicate(entry, state));
    case "not": return !matchesMechanicsPredicate(predicate.predicate, state);
    case "clue_found": return state.foundClueIds.includes(predicate.clueId);
    case "scene_visited": return state.visitedSceneIds.includes(predicate.sceneId);
    case "current_scene": return state.currentSceneId === predicate.sceneId;
    case "item_owned": return state.ownedItemIds.includes(predicate.itemId);
    case "connection_unlocked": return state.unlockedConnectionIds.includes(predicate.connectionId);
    case "state_eq": return canonical(state.stateValues[predicate.stateKey]) === canonical(predicate.value);
    case "npc_state": return state.npcStates[predicate.npcId] === predicate.state;
    case "encounter_defeated": return state.encounters[predicate.encounterId]?.status === "defeated";
  }
}

function encounterDefinition(ir: MechanicsIR, encounterId: string) {
  const definition = ir.encounterDefinitions.find((entry) => entry.encounterId === encounterId);
  if (!definition) throw new MechanicsReachabilityError("unknown_encounter", `encounter definition is missing: ${encounterId}`);
  return definition;
}

/** Reject forged state before any listing, automatic settlement, or execution can choose an arbitrary encounter. */
function validateEncounterRuntimeState(ir: MechanicsIR, state: MechanicsState): void {
  const encounters = state.encounters;
  if (!encounters || typeof encounters !== "object" || Array.isArray(encounters)) throw new MechanicsReachabilityError("invalid_encounter_state", "encounter state must be a record");
  const encounterIds = Object.keys(encounters).sort();
  if (JSON.stringify([...state.startedEncounterIds].sort()) !== JSON.stringify(encounterIds)) throw new MechanicsReachabilityError("invalid_encounter_state", "started encounter compatibility IDs do not match canonical encounter state");
  let activeCount = 0;
  for (const encounterId of encounterIds) {
    const encounter = encounters[encounterId];
    const definition = ir.encounterDefinitions.find((entry) => entry.encounterId === encounterId);
    if (!definition || !encounter || typeof encounter !== "object" || (encounter.status !== "active" && encounter.status !== "defeated") || !Number.isInteger(encounter.currentHp)) {
      throw new MechanicsReachabilityError("invalid_encounter_state", `invalid encounter state: ${encounterId}`);
    }
    if (encounter.status === "active") {
      activeCount++;
      if (encounter.currentHp < 1 || encounter.currentHp > definition.maxHp) throw new MechanicsReachabilityError("invalid_encounter_state", `active encounter HP is invalid: ${encounterId}`);
    } else if (encounter.currentHp !== 0) {
      throw new MechanicsReachabilityError("invalid_encounter_state", `defeated encounter HP is invalid: ${encounterId}`);
    }
  }
  if (activeCount > 1) throw new MechanicsReachabilityError("invalid_encounter_state", "multiple active encounters are not supported");
  if (state.terminalEndingId && state.terminalLoss) throw new MechanicsReachabilityError("invalid_encounter_state", "terminal ending and terminal loss cannot coexist");
  if (state.terminalLoss) {
    const encounter = encounters[state.terminalLoss.encounterId];
    const definition = encounter && ir.encounterDefinitions.find((entry) => entry.encounterId === state.terminalLoss!.encounterId);
    if (state.terminalLoss.kind !== "encounter_defeat" || !definition || encounter?.status !== "active" || definition.combatantId !== state.terminalLoss.combatantId) {
      throw new MechanicsReachabilityError("invalid_encounter_state", "terminal loss does not reference an active encounter combatant");
    }
  }
}

/** Applies deterministic mechanics effects. Starting an encounter requires its compiled definition. */
export function applyMechanicsEffects(state: MechanicsState, effects: readonly Effect[], ir?: MechanicsIR): MechanicsState {
  const next: MechanicsState = structuredClone(state);
  for (const effect of effects) {
    switch (effect.kind) {
      case "discover_clue": next.foundClueIds = sorted([...next.foundClueIds, effect.clueId]); break;
      case "acquire_item": next.ownedItemIds = sorted([...next.ownedItemIds, effect.itemId]); break;
      case "set_state": next.stateValues[effect.stateKey] = effect.value; break;
      case "unlock_connection": next.unlockedConnectionIds = sorted([...next.unlockedConnectionIds, effect.connectionId]); break;
      case "start_encounter": {
        if (!ir) throw new MechanicsReachabilityError("encounter_definition_required", "start_encounter requires compiled encounter definitions");
        const definition = encounterDefinition(ir, effect.encounterId);
        if (definition.sceneId !== next.currentSceneId) throw new MechanicsReachabilityError("encounter_scene_mismatch", `encounter starts outside its source scene: ${effect.encounterId}`);
        const current = next.encounters[effect.encounterId];
        if (current) break; // A repeated start is idempotent and can never heal a wounded enemy.
        const active = activeEncounterId(next);
        if (active) throw new MechanicsReachabilityError("multiple_active_encounters", `cannot start ${effect.encounterId} while ${active} is active`);
        next.encounters[effect.encounterId] = { status: "active", currentHp: definition.maxHp };
        break;
      }
      case "sanity_check": throw new MechanicsReachabilityError("actor_effect_requires_settlement", "sanity_check must be settled by the player-action executor");
      case "reward": next.rewardIds = sorted([...next.rewardIds, effect.rewardId]); break;
      case "end_game": next.terminalEndingId = effect.endingId; break;
    }
  }
  return normalizeMechanicsState(next);
}

/** Separates actor consequences from state effects at the shared action boundary. */
export function partitionPlayerActionEffects(effects: readonly Effect[], outcome: SelectedActorEffect["outcome"], sourceInterpretationIds: readonly string[] = [], actorEffectProvenance: readonly ActorEffectProvenance[] = [], effectPathPrefix = "effects"): { mechanicsEffects: Effect[]; actorEffects: SelectedActorEffect[] } {
  const mechanicsEffects: Effect[] = [];
  const actorEffects: SelectedActorEffect[] = [];
  for (const [effectIndex, effect] of effects.entries()) {
    if (effect.kind === "sanity_check") {
      const effectPath = `${effectPathPrefix}[${effectIndex}]`;
      const provenance = actorEffectProvenance.find((candidate) => candidate.effectPath === effectPath && candidate.eventSlot.outcome === outcome && candidate.eventSlot.effectIndex === effectIndex);
      if (!provenance) throw new MechanicsReachabilityError("missing_actor_effect_provenance", `SAN effect has no exact selected provenance: ${effectPath}`);
      actorEffects.push({ outcome, effectIndex, effectPath, effect: structuredClone(effect), provenance: structuredClone(provenance), sourceInterpretationIds: [...sourceInterpretationIds].sort() });
    }
    else mechanicsEffects.push(effect);
  }
  return { mechanicsEffects, actorEffects };
}

/** Applies only state effects; the caller must durably settle returned actor effects. */
export function applyPlayerMechanicsEffects(state: MechanicsState, effects: readonly Effect[], outcome: SelectedActorEffect["outcome"], sourceInterpretationIds: readonly string[] = [], actorEffectProvenance: readonly ActorEffectProvenance[] = [], effectPathPrefix = "effects", ir?: MechanicsIR): { state: MechanicsState; actorEffects: SelectedActorEffect[] } {
  const partitioned = partitionPlayerActionEffects(effects, outcome, sourceInterpretationIds, actorEffectProvenance, effectPathPrefix);
  return { state: applyMechanicsEffects(state, partitioned.mechanicsEffects, ir), actorEffects: partitioned.actorEffects };
}

/**
 * Rewards are evaluated exactly once at the terminal shared-core boundary,
 * after the ending's ordinary effects have produced the stable terminal
 * state.  Legacy `reward` effects are rejected by MechanicsIR and runtime;
 * the source-bound catalog is the sole semantic authority.
 */
export function applyTerminalRewards(ir: MechanicsIR, state: MechanicsState): MechanicsState {
  if (!state.terminalEndingId) return normalizeMechanicsState(state);
  return normalizeMechanicsState({
    ...state,
    rewardIds: sorted([...state.rewardIds, ...ir.rewards.filter((reward) => matchesMechanicsPredicate(reward.when, state)).map((reward) => reward.id)]),
  });
}

function terminalEffects(effects: readonly Effect[]): Effect[] {
  if (effects.some((effect) => effect.kind === "reward")) {
    throw new MechanicsReachabilityError("invalid_reward_effect", "reward effects are not executable; use the source-bound reward catalog");
  }
  if (effects.some((effect) => effect.kind === "sanity_check")) {
    throw new MechanicsReachabilityError("invalid_actor_effect", "sanity_check is not executable from an automatic or terminal effect");
  }
  return [...effects];
}

function summary(before: MechanicsState, after: MechanicsState): string {
  const changes: string[] = [];
  if (before.currentSceneId !== after.currentSceneId) changes.push(`scene:${before.currentSceneId}->${after.currentSceneId}`);
  const added = (beforeValues: string[], afterValues: string[], label: string) => {
    const values = afterValues.filter((value) => !beforeValues.includes(value));
    if (values.length) changes.push(`${label}:${values.join(",")}`);
  };
  added(before.foundClueIds, after.foundClueIds, "clue");
  added(before.ownedItemIds, after.ownedItemIds, "item");
  added(before.unlockedConnectionIds, after.unlockedConnectionIds, "unlock");
  added(before.startedEncounterIds, after.startedEncounterIds, "encounter");
  for (const encounterId of [...new Set([...Object.keys(before.encounters), ...Object.keys(after.encounters)])].sort()) {
    const previous = before.encounters[encounterId];
    const next = after.encounters[encounterId];
    if (previous && next && previous.currentHp !== next.currentHp) changes.push(`encounter:${encounterId}:hp=${previous.currentHp}->${next.currentHp}`);
    if (previous && next && previous.status !== next.status) changes.push(`encounter:${encounterId}:status=${previous.status}->${next.status}`);
  }
  added(before.rewardIds, after.rewardIds, "reward");
  for (const [key, value] of Object.entries(after.stateValues)) if (canonical(before.stateValues[key]) !== canonical(value)) changes.push(`state:${key}=${canonical(value)}`);
  for (const [key, value] of Object.entries(after.failureCounts)) if (before.failureCounts[key] !== value) changes.push(`failures:${key}=${value}`);
  if (before.terminalEndingId !== after.terminalEndingId && after.terminalEndingId) changes.push(`ending:${after.terminalEndingId}`);
  if (!before.terminalLoss && after.terminalLoss) changes.push(`loss:${after.terminalLoss.encounterId}`);
  return changes.join("; ") || "no state change";
}

export function createMechanicsEdge(mechanismId: string, outcome: MechanicsOutcome, before: MechanicsState, after: MechanicsState, sourceInterpretationIds: string[], mechanismIds: string[] = [mechanismId], combat?: MechanicsCombatOutcome): MechanicsReachabilityEdge {
  if ((outcome === "attack") !== (combat !== undefined)) throw new MechanicsReachabilityError("invalid_combat_edge", "combat payload must exist only on attack edges");
  return { mechanismId, mechanismIds: sorted(mechanismIds), outcome, ...(combat ? { combat: structuredClone(combat) } : {}), beforeStateHash: mechanicsStateHash(before), afterStateHash: mechanicsStateHash(after), sourceInterpretationIds: sorted(sourceInterpretationIds), summary: summary(before, after) };
}

function checked(discovery: MechanicsIR["discoveryMethods"][number]): boolean { return discovery.check !== undefined && discovery.check.kind !== "none"; }

function validateCompatibleAutomaticEffects(transitions: MechanicsIR["transitions"]): void {
  const writes = new Map<string, string>();
  const endingIds = new Set<string>();
  for (const transition of transitions) for (const effect of transition.effects) {
    if (effect.kind === "set_state") {
      const value = canonical(effect.value);
      const previous = writes.get(effect.stateKey);
      if (previous !== undefined && previous !== value) throw new MechanicsReachabilityError("automatic_transition_conflict", `automatic transitions disagree on ${effect.stateKey}`);
      writes.set(effect.stateKey, value);
    }
    if (effect.kind === "end_game") endingIds.add(effect.endingId);
  }
  if (endingIds.size > 1) throw new MechanicsReachabilityError("automatic_transition_conflict", "automatic transitions select different endings");
}

function automaticBatchId(ids: readonly string[]): string { return ids.length === 1 ? ids[0]! : `automatic:${[...ids].sort().join("+")}`; }

/** Executes exactly one terminal-first automatic step; compatible transitions are one atomic batch. */
export function nextAutomaticMechanicsStep(ir: MechanicsIR, state: MechanicsState): { state: MechanicsState; step: MechanicsReachabilityEdge } | undefined {
  validateEncounterRuntimeState(ir, state);
  if (terminal(state)) return undefined;
  const selectedEnding = ir.endings.filter((ending) => matchesMechanicsPredicate(ending.when, state)).sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];
  if (selectedEnding) {
    const terminal = applyTerminalRewards(ir, applyMechanicsEffects(state, terminalEffects(selectedEnding.effects), ir));
    if (!terminal.terminalEndingId) throw new MechanicsReachabilityError("invalid_terminal", `ending rule did not produce end_game: ${selectedEnding.id}`);
    return { state: terminal, step: createMechanicsEdge(selectedEnding.id, "ending", state, terminal, selectedEnding.sourceInterpretationIds) };
  }
  const transitions = ir.transitions.filter((transition) => matchesMechanicsPredicate(transition.when, state));
  if (transitions.length === 0) return undefined;
  validateCompatibleAutomaticEffects(transitions);
  const transitional = applyMechanicsEffects(state, transitions.flatMap((transition) => terminalEffects(transition.effects)), ir);
  const next = applyTerminalRewards(ir, transitional);
  if (mechanicsStateHash(next) === mechanicsStateHash(state)) return undefined;
  const ids = transitions.map((transition) => transition.id).sort();
  return { state: next, step: createMechanicsEdge(automaticBatchId(ids), "transition", state, next, transitions.flatMap((transition) => transition.sourceInterpretationIds), ids) };
}

export function settleAutomaticMechanics(ir: MechanicsIR, initial: MechanicsState, budget?: MechanicsStateBudget): MechanicsClosureTrace {
  let state = normalizeMechanicsState(initial);
  const steps: MechanicsReachabilityEdge[] = [];
  const hash = budget?.observe(state) ?? mechanicsStateHash(state);
  const states: MechanicsClosureTrace["states"] = [{ state, hash, stepCount: 0 }];
  const closureHashes = new Set<string>([hash]);
  while (true) {
    const automatic = nextAutomaticMechanicsStep(ir, state);
    if (!automatic) break;
    const afterHash = budget?.observe(automatic.state) ?? mechanicsStateHash(automatic.state);
    if (closureHashes.has(afterHash)) throw new MechanicsReachabilityError("automatic_transition_cycle", "automatic transitions form a closed state cycle");
    closureHashes.add(afterHash);
    steps.push(automatic.step);
    state = automatic.state;
    states.push({ state, hash: afterHash, stepCount: steps.length });
    if (terminal(state)) break;
  }
  return { state, steps, states };
}

function possibleDamage(spec: CombatDamageSpec): number[] {
  return spec.kind === "fixed" ? [spec.amount] : Array.from({ length: spec.count * spec.sides - spec.count + 1 }, (_, index) => spec.count + index);
}

function sameCombat(left: MechanicsCombatOutcome | undefined, right: MechanicsCombatOutcome | undefined): boolean {
  return canonical(left) === canonical(right);
}

function validateCombatRequest(ir: MechanicsIR, state: MechanicsState, request: Extract<MechanicsActionRequest, { outcome: "attack" }>): void {
  const activeId = activeEncounterId(state);
  const combat = request.combat;
  if (!activeId || combat.encounterId !== activeId) throw new MechanicsReachabilityError("combat_result_invalid", "attack does not target the active encounter");
  const definition = encounterDefinition(ir, activeId);
  const current = state.encounters[activeId]!;
  if (combat.kind !== "attack" || combat.targetId !== definition.combatantId || request.mechanismId !== `attack:${activeId}`) {
    throw new MechanicsReachabilityError("combat_result_invalid", "attack target or mechanism does not match encounter definition");
  }
  if (!combat.hit && combat.damage !== 0) throw new MechanicsReachabilityError("combat_result_invalid", "a missed attack must inflict zero damage");
  if (combat.hit && !possibleDamage(PLAYER_UNARMED_ATTACK_POLICY).includes(combat.damage)) {
    throw new MechanicsReachabilityError("combat_result_invalid", "attack damage is outside the unarmed engine-policy grammar");
  }
  const playerKillsEnemy = combat.hit && combat.damage >= current.currentHp;
  if (playerKillsEnemy && (combat.enemyHit || combat.actorDamage !== 0 || combat.actorDefeated)) {
    throw new MechanicsReachabilityError("combat_result_invalid", "a killing attack cannot receive an enemy retaliation");
  }
  if (!combat.enemyHit && (combat.actorDamage !== 0 || combat.actorDefeated)) {
    throw new MechanicsReachabilityError("combat_result_invalid", "actor damage and defeat require an enemy hit");
  }
  if (combat.enemyHit && !possibleDamage(definition.npcDamage).includes(combat.actorDamage)) {
    throw new MechanicsReachabilityError("combat_result_invalid", "enemy counterdamage is outside the source-bound NPC damage grammar");
  }
}

function combatAction(ir: MechanicsIR, state: MechanicsState, combat: MechanicsCombatOutcome): MechanicsPlayerAction {
  const encounterId = combat.encounterId;
  const definition = encounterDefinition(ir, encounterId);
  let next: MechanicsState = structuredClone(state);
  const current = next.encounters[encounterId]!;
  if (combat.hit) {
    current.currentHp = Math.max(0, current.currentHp - combat.damage);
    if (current.currentHp === 0) {
      current.status = "defeated";
      next = applyMechanicsEffects(next, definition.victoryEffects, ir);
    }
  }
  if (combat.actorDefeated) next.terminalLoss = { kind: "encounter_defeat", encounterId, combatantId: definition.combatantId };
  return { mechanismId: `attack:${encounterId}`, outcome: "attack", combat: structuredClone(combat), next: normalizeMechanicsState(next), actorEffects: [], sourceInterpretationIds: [...definition.sourceInterpretationIds] };
}

/** Lists all executable optional actions after callers settle automatic mechanics. */
export function availableMechanicsPlayerActions(ir: MechanicsIR, input: MechanicsAnalysisInput, state: MechanicsState): MechanicsPlayerAction[] {
  validateEncounterRuntimeState(ir, state);
  if (terminal(state)) return [];
  const activeId = activeEncounterId(state);
  if (activeId) {
    const definition = encounterDefinition(ir, activeId);
    const currentHp = state.encounters[activeId]!.currentHp;
    const retaliation = (): MechanicsCombatOutcome[] => [
      { kind: "attack", encounterId: activeId, targetId: definition.combatantId, hit: false, damage: 0, enemyHit: false, actorDamage: 0, actorDefeated: false },
      ...possibleDamage(definition.npcDamage).flatMap((actorDamage): MechanicsCombatOutcome[] => [
        { kind: "attack", encounterId: activeId, targetId: definition.combatantId, hit: false, damage: 0, enemyHit: true, actorDamage, actorDefeated: false },
        { kind: "attack", encounterId: activeId, targetId: definition.combatantId, hit: false, damage: 0, enemyHit: true, actorDamage, actorDefeated: true },
      ]),
    ];
    const candidates: MechanicsCombatOutcome[] = [
      ...retaliation(),
      ...possibleDamage(PLAYER_UNARMED_ATTACK_POLICY).flatMap((damage): MechanicsCombatOutcome[] => damage >= currentHp
        ? [{ kind: "attack", encounterId: activeId, targetId: definition.combatantId, hit: true, damage, enemyHit: false, actorDamage: 0, actorDefeated: false }]
        : retaliation().map((candidate) => ({ ...candidate, hit: true as const, damage }))),
    ];
    return candidates.map((combat) => combatAction(ir, state, combat));
  }
  const actions: MechanicsPlayerAction[] = [];
  for (const discovery of ir.discoveryMethods) {
    if (state.foundClueIds.includes(discovery.clueId)) continue;
    if (input.discoveryLocations[discovery.id] !== state.currentSceneId || (discovery.availability && !matchesMechanicsPredicate(discovery.availability, state))) continue;
    const success = applyPlayerMechanicsEffects(state, discovery.onSuccess, "success", discovery.sourceInterpretationIds, discovery.actorEffectProvenance, "onSuccess", ir);
    actions.push({ mechanismId: discovery.id, outcome: "success", next: success.state, actorEffects: success.actorEffects, sourceInterpretationIds: [...discovery.sourceInterpretationIds] });
    if (!checked(discovery)) continue;
    const count = Object.hasOwn(state.failureCounts, discovery.id) ? state.failureCounts[discovery.id]! : 0;
    if (discovery.failback && count >= discovery.failback.maxFailures) {
      const failback = applyPlayerMechanicsEffects(state, discovery.failback.effects, "failback", discovery.sourceInterpretationIds, discovery.actorEffectProvenance, "failback.effects", ir);
      actions.push({ mechanismId: discovery.id, outcome: "failback", next: failback.state, actorEffects: failback.actorEffects, sourceInterpretationIds: [...discovery.sourceInterpretationIds] });
    }
    else {
      const failedAction = applyPlayerMechanicsEffects(state, discovery.onFailure ?? [], "failure", discovery.sourceInterpretationIds, discovery.actorEffectProvenance, "onFailure", ir);
      const failed = failedAction.state;
      if (discovery.failback) Object.defineProperty(failed.failureCounts, discovery.id, {
        value: Math.min(count + 1, discovery.failback.maxFailures), enumerable: true, writable: true, configurable: true,
      });
      actions.push({ mechanismId: discovery.id, outcome: "failure", next: normalizeMechanicsState(failed), actorEffects: failedAction.actorEffects, sourceInterpretationIds: [...discovery.sourceInterpretationIds] });
    }
  }
  for (const gate of ir.connections) {
    const connection = input.connections.find((entry) => entry.id === gate.connectionId)!;
    if (connection.fromSceneId !== state.currentSceneId || (gate.availability && !matchesMechanicsPredicate(gate.availability, state))) continue;
    const traversal = applyPlayerMechanicsEffects(state, gate.onTraverse ?? [], "traverse", gate.sourceInterpretationIds, gate.actorEffectProvenance, "onTraverse", ir);
    const traversed = traversal.state;
    traversed.currentSceneId = connection.toSceneId;
    traversed.visitedSceneIds = sorted([...traversed.visitedSceneIds, connection.toSceneId]);
    actions.push({ mechanismId: gate.id, outcome: "traverse", next: normalizeMechanicsState(traversed), actorEffects: traversal.actorEffects, sourceInterpretationIds: [...gate.sourceInterpretationIds] });
  }
  return actions;
}

export function executeMechanicsAction(ir: MechanicsIR, input: MechanicsAnalysisInput, state: MechanicsState, requested: MechanicsActionRequest): { state: MechanicsState; edge: MechanicsReachabilityEdge; actorEffects: SelectedActorEffect[] } {
  if (nextAutomaticMechanicsStep(ir, state)) throw new MechanicsReachabilityError("action_before_settlement", "requested action is unavailable before automatic settlement");
  if (terminal(state)) throw new MechanicsReachabilityError("action_after_terminal", "requested action is unavailable after terminal state");
  if (requested.outcome === "attack") validateCombatRequest(ir, state, requested);
  const action = availableMechanicsPlayerActions(ir, input, state).find((candidate) => candidate.mechanismId === requested.mechanismId && candidate.outcome === requested.outcome && (candidate.outcome !== "attack" || requested.outcome === "attack" && sameCombat(candidate.combat, requested.combat)));
  if (!action) throw new MechanicsReachabilityError("action_unavailable", `requested action is unavailable: ${requested.mechanismId}:${requested.outcome}`);
  return { state: action.next, edge: createMechanicsEdge(action.mechanismId, action.outcome, state, action.next, action.sourceInterpretationIds, undefined, action.outcome === "attack" ? action.combat : undefined), actorEffects: structuredClone(action.actorEffects) };
}

export function initialMechanicsState(input: MechanicsAnalysisInput): MechanicsState {
  return normalizeMechanicsState({ currentSceneId: input.entrySceneId, foundClueIds: input.initialState.foundClueIds, visitedSceneIds: [...input.initialState.visitedSceneIds, input.entrySceneId], ownedItemIds: input.initialState.ownedItemIds, stateValues: input.initialState.stateValues, npcStates: input.initialState.npcStates, unlockedConnectionIds: [], failureCounts: {}, encounters: {}, startedEncounterIds: [], rewardIds: [] });
}

/**
 * Installs the entry state and exhausts the same terminal-first automatic
 * semantics used after every player action.  Compiler closure, reachability,
 * snapshots, and GameSession must use this entry point rather than each
 * rebuilding its own initial-settlement convention.
 */
export function settleInitialMechanics(ir: MechanicsIR, input: MechanicsAnalysisInput, budget?: MechanicsStateBudget): MechanicsClosureTrace {
  return settleAutomaticMechanics(ir, initialMechanicsState(input), budget);
}
