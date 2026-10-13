import { sha256 } from "../ingest/document-ir";
import { validateSourceFactGraph, type FactInterpretationCandidate, type SourceFactGraph } from "./source-fact-graph";

export const MECHANICS_IR_SCHEMA_VERSION = "1.6.0";

export type Scalar = string | number | boolean | null;
export type Difficulty = "regular" | "hard" | "extreme";
export type DiscoveryAction = "observe" | "search" | "talk" | "read" | "use_item" | "move" | "custom";
export type DiscoveryTarget = "clue" | "item" | "npc" | "scene";

export type Predicate =
  | { kind: "all"; predicates: Predicate[] }
  | { kind: "any"; predicates: Predicate[] }
  | { kind: "not"; predicate: Predicate }
  | { kind: "clue_found"; clueId: string }
  | { kind: "scene_visited"; sceneId: string }
  /** Current location, deliberately distinct from historical scene_visited. */
  | { kind: "current_scene"; sceneId: string }
  | { kind: "item_owned"; itemId: string }
  /** An ordinary connection is traversable unless a gate explicitly uses this predicate. */
  | { kind: "connection_unlocked"; connectionId: string }
  | { kind: "state_eq"; stateKey: string; value: Scalar }
  | { kind: "npc_state"; npcId: string; state: string }
  | { kind: "encounter_defeated"; encounterId: string };

export type Effect =
  | { kind: "discover_clue"; clueId: string }
  | { kind: "acquire_item"; itemId: string }
  | { kind: "set_state"; stateKey: string; value: Scalar }
  | { kind: "unlock_connection"; connectionId: string }
  | { kind: "start_encounter"; encounterId: string }
  /** Actor-only CoC SAN check. The executor, not MechanicsState, settles it. */
  | { kind: "sanity_check"; passLoss: SanityLossSpec; failLoss: SanityLossSpec }
  | { kind: "reward"; rewardId: string }
  | { kind: "end_game"; endingId: string };

/** A bounded, source-declared SAN loss expression; never an arbitrary string DSL. */
export type SanityLossSpec =
  | { kind: "fixed"; amount: number }
  | { kind: "dice"; count: number; sides: number };

/** A deliberately small arithmetic grammar shared by source NPCs and policy attacks. */
export type CombatDamageSpec =
  | { kind: "fixed"; amount: number }
  | { kind: "dice"; count: number; sides: number };

export type SanityCheckEffect = Extract<Effect, { kind: "sanity_check" }>;

/**
 * A SAN check is an actor consequence, not a second Effect DSL.  Its source
 * binding belongs to the concrete player-action slot which selects it.
 */
export interface ActorEffectProvenance {
  /** Exact branch-local address, e.g. onTraverse[1] or onFailure[0]. */
  effectPath: string;
  eventSlot:
    | { kind: "connection"; connectionId: string; outcome: "traverse"; effectIndex: number }
    | { kind: "discovery"; mechanismId: string; outcome: "success" | "failure" | "failback"; effectIndex: number };
  /** Exact, question-scoped source declaration consumed by this slot. */
  source: { statementId: string; quote: string };
}

export type CheckSpec =
  | { kind: "none" }
  | { kind: "skill"; skill: string; difficulty: Difficulty }
  | { kind: "attribute"; attribute: "str" | "dex" | "pow" | "con" | "app" | "edu" | "int" | "siz"; difficulty: Difficulty };

export interface DiscoveryMethodIR {
  id: string;
  clueId: string;
  action: DiscoveryAction;
  target: DiscoveryTarget;
  targetId: string;
  availability?: Predicate;
  check?: CheckSpec;
  onSuccess: Effect[];
  onFailure?: Effect[];
  failback?: { maxFailures: number; effects: Effect[] };
  /** Present iff a discovery branch declares one or more sanity_check effects. */
  actorEffectProvenance?: ActorEffectProvenance[];
  sourceInterpretationIds: string[];
}

export interface ConnectionGateIR {
  id: string;
  connectionId: string;
  availability?: Predicate;
  onTraverse?: Effect[];
  /** Present iff this traversal declares one or more sanity_check effects. */
  actorEffectProvenance?: ActorEffectProvenance[];
  sourceInterpretationIds: string[];
}

export interface StateTransitionIR {
  id: string;
  when: Predicate;
  effects: Effect[];
  sourceInterpretationIds: string[];
}

export interface EndingRuleIR {
  id: string;
  priority: number;
  when: Predicate;
  effects: Effect[];
  sourceInterpretationIds: string[];
}

/**
 * One source-bound, single-enemy encounter.  This is intentionally not a
 * general combat language: one NPC, bounded HP, and bounded damage grammar.
 */
export interface EncounterDefinitionIR {
  id: string;
  encounterId: string;
  sceneId: string;
  combatantId: string;
  maxHp: number;
  dodge: number;
  fight: number;
  npcDamage: CombatDamageSpec;
  victoryEffects: Effect[];
  sourceInterpretationIds: string[];
}

/**
 * A terminal-only, source-reviewed reward.  This deliberately reuses the
 * ordinary MechanicsIR predicate AST: there is no free-form reward DSL.
 */
export interface RewardDefinitionIR {
  id: string;
  when: RewardPredicate;
  settlement: RewardSettlement;
  sourceInterpretationIds: string[];
}

/** The reward boundary intentionally admits only stable, symbol-scoped facts. */
export type RewardPredicate =
  | { kind: "all"; predicates: RewardPredicate[] }
  | { kind: "any"; predicates: RewardPredicate[] }
  | { kind: "not"; predicate: RewardPredicate }
  | { kind: "clue_found"; clueId: string }
  | { kind: "scene_visited"; sceneId: string }
  | { kind: "item_owned"; itemId: string };

export type RewardSanSettlement =
  | { kind: "fixed"; amount: number }
  | { kind: "dice"; count: number; sides: number };

export interface RewardSettlement {
  /** Positive SAN recovery only.  Loss has insanity semantics and is rejected here. */
  san?: RewardSanSettlement;
  cthulhuMythos?: number;
  reputation?: number;
}

/** Durable, rolled outcome for one terminal reward; written by GameSession. */
export interface TerminalRewardSettlement {
  rewardId: string;
  sourceInterpretationIds: string[];
  san?: {
    kind: RewardSanSettlement["kind"];
    count?: number;
    sides?: number;
    rolls?: number[];
    total: number;
    before: number;
    after: number;
  };
  /** CM changes also lower both SAN caps before any recovery in this reward. */
  cthulhuMythos?: {
    delta: number;
    before: number;
    after: number;
    maxSanBefore: number;
    maxSanAfter: number;
    currentSanBefore: number;
    currentSanAfter: number;
  };
  reputation?: { delta: number; before: number; after: number };
}

/**
 * Auditable result of one source-bound actor SAN check.  This deliberately
 * records the declared grammar and every random outcome, but not a second
 * full SanityState snapshot; the state hashes bind the before/after chain.
 */
export interface SanityCheckSettlement {
  actorId: "p1";
  mechanismId: string;
  /** The selected discovery branch or connection traversal. */
  outcome: "success" | "failure" | "failback" | "traverse";
  /** Original position in that branch's effects array, never a compacted index. */
  effectIndex: number;
  effectPath: string;
  /** Source-bound event-slot provenance selected by the shared executor. */
  provenance: ActorEffectProvenance;
  sourceInterpretationIds: string[];
  declared: { passLoss: SanityLossSpec; failLoss: SanityLossSpec };
  check: {
    roll: number;
    passed: boolean;
    selectedLoss: SanityLossSpec;
    rolls: number[];
    total: number;
    appliedLoss: number;
  };
  madness: {
    temporaryInsanityTriggered: boolean;
    indefiniteInsanityTriggered: boolean;
    indefiniteLevel: "mild" | "moderate" | "severe" | null;
    boutDetail: { type: string; symptom: string; guidance: string; residual: string | null; outcome: string } | null;
    newPhobias: string[];
    newManias: string[];
  };
  beforeSanityHash: string;
  afterSanityHash: string;
}

export interface MechanicsSymbols {
  clueIds: string[];
  sceneIds: string[];
  itemIds: string[];
  npcIds: string[];
  connectionIds: string[];
  encounterIds: string[];
  endingIds: string[];
  rewardIds: string[];
  declaredStateKeys: string[];
}

export interface MechanicsIR {
  schemaVersion: typeof MECHANICS_IR_SCHEMA_VERSION;
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  mechanicsHash: string;
  symbols: MechanicsSymbols;
  /** Catalog retained so validation can reject dangling mechanism provenance. */
  sourceInterpretationIds: string[];
  discoveryMethods: DiscoveryMethodIR[];
  connections: ConnectionGateIR[];
  transitions: StateTransitionIR[];
  endings: EndingRuleIR[];
  encounterDefinitions: EncounterDefinitionIR[];
  rewards: RewardDefinitionIR[];
}

export type DiscoveryMethodSpec = Omit<DiscoveryMethodIR, "sourceInterpretationIds"> & { kind: "discovery_method" };
export type ConnectionGateSpec = Omit<ConnectionGateIR, "sourceInterpretationIds"> & { kind: "connection_gate" };
export type StateTransitionSpec = Omit<StateTransitionIR, "sourceInterpretationIds"> & { kind: "state_transition" };
export type EndingRuleSpec = Omit<EndingRuleIR, "sourceInterpretationIds"> & { kind: "ending_rule" };
export type EncounterDefinitionSpec = Omit<EncounterDefinitionIR, "sourceInterpretationIds"> & { kind: "encounter_definition" };
export type RewardDefinitionSpec = Omit<RewardDefinitionIR, "sourceInterpretationIds"> & { kind: "reward_definition" };
export type MechanicsCandidateSpec = DiscoveryMethodSpec | ConnectionGateSpec | StateTransitionSpec | EndingRuleSpec | EncounterDefinitionSpec | RewardDefinitionSpec;

export interface MechanicsCompilationInput {
  moduleId: string;
  documentHash: string | null;
  sourceGraphSchemaVersion: string;
  symbols: MechanicsSymbols;
  acceptedInterpretationIds: string[];
  requiredMechanicIds?: string[];
  /** Strict is the default; compatible mode requires an explicit policy allowlist. */
  compilationMode?: "strict" | "compatible";
  allowedEnginePolicyIds?: string[];
}

export class MechanicsCompilationError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
    readonly interpretationId?: string,
    readonly path?: string,
    readonly sourceStatementIds?: string[],
  ) {
    super(reason);
    this.name = "MechanicsCompilationError";
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as RecordValue;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function assertKeys(value: RecordValue, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new MechanicsCompilationError("invalid_schema", `undeclared field: ${path}.${key}`, undefined, `${path}.${key}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new MechanicsCompilationError("invalid_schema", `expected non-empty string: ${path}`, undefined, path);
  return value;
}

function scalar(value: unknown, path: string): Scalar {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new MechanicsCompilationError("invalid_schema", `expected scalar value: ${path}`, undefined, path);
}

function requiredEffects(value: unknown, path: string, allowEmpty = false): Effect[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new MechanicsCompilationError("invalid_schema", `expected ${allowEmpty ? "effects" : "non-empty effects"}: ${path}`, undefined, path);
  if (value.length > 100) throw new MechanicsCompilationError("invalid_schema", `too many effects in one player/automatic branch: ${path}`, undefined, path);
  return value.map((entry, index) => parseEffect(entry, `${path}[${index}]`));
}

function parseSanityLossSpec(value: unknown, path: string): SanityLossSpec {
  if (!isRecord(value)) throw new MechanicsCompilationError("invalid_sanity_loss", `expected SAN loss object: ${path}`, undefined, path);
  const kind = requiredString(value.kind, `${path}.kind`);
  if (kind === "fixed") {
    assertKeys(value, ["kind", "amount"], path);
    if (typeof value.amount !== "number" || !Number.isInteger(value.amount) || value.amount < 0 || value.amount > 100) {
      throw new MechanicsCompilationError("invalid_sanity_loss", "fixed SAN loss must be an integer from 0 to 100", undefined, `${path}.amount`);
    }
    return { kind, amount: value.amount };
  }
  if (kind === "dice") {
    assertKeys(value, ["kind", "count", "sides"], path);
    if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 1 || value.count > 10
      || typeof value.sides !== "number" || !Number.isInteger(value.sides) || value.sides < 2 || value.sides > 100
      || value.count * value.sides > 100) {
      throw new MechanicsCompilationError("invalid_sanity_loss", "SAN dice loss must be bounded 1..10d2..100 with maximum total no greater than 100", undefined, path);
    }
    return { kind, count: value.count, sides: value.sides };
  }
  throw new MechanicsCompilationError("invalid_sanity_loss", `unsupported SAN loss kind: ${kind}`, undefined, `${path}.kind`);
}

/** Combat uses a finite numeric grammar, never free-form damage text. */
function parseCombatDamageSpec(value: unknown, path: string): CombatDamageSpec {
  if (!isRecord(value)) throw new MechanicsCompilationError("invalid_combat_damage", `expected combat damage object: ${path}`, undefined, path);
  const kind = requiredString(value.kind, `${path}.kind`);
  if (kind === "fixed") {
    assertKeys(value, ["kind", "amount"], path);
    if (typeof value.amount !== "number" || !Number.isInteger(value.amount) || value.amount < 1 || value.amount > 20) {
      throw new MechanicsCompilationError("invalid_combat_damage", "fixed combat damage must be an integer from 1 to 20", undefined, `${path}.amount`);
    }
    return { kind, amount: value.amount };
  }
  if (kind === "dice") {
    assertKeys(value, ["kind", "count", "sides"], path);
    if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 1 || value.count > 3
      || typeof value.sides !== "number" || !Number.isInteger(value.sides) || value.sides < 2 || value.sides > 10
      || value.count * value.sides > 20) {
      throw new MechanicsCompilationError("invalid_combat_damage", "combat dice damage must be bounded 1..3d2..10 with maximum total no greater than 20", undefined, path);
    }
    return { kind, count: value.count, sides: value.sides };
  }
  throw new MechanicsCompilationError("invalid_combat_damage", `unsupported combat damage kind: ${kind}`, undefined, `${path}.kind`);
}

function parseEffect(value: unknown, path: string): Effect {
  if (!isRecord(value)) throw new MechanicsCompilationError("invalid_schema", `expected effect object: ${path}`, undefined, path);
  const kind = requiredString(value.kind, `${path}.kind`);
  switch (kind) {
    case "discover_clue":
      assertKeys(value, ["kind", "clueId"], path);
      return { kind, clueId: requiredString(value.clueId, `${path}.clueId`) };
    case "acquire_item":
      assertKeys(value, ["kind", "itemId"], path);
      return { kind, itemId: requiredString(value.itemId, `${path}.itemId`) };
    case "set_state":
      assertKeys(value, ["kind", "stateKey", "value"], path);
      return { kind, stateKey: requiredString(value.stateKey, `${path}.stateKey`), value: scalar(value.value, `${path}.value`) };
    case "unlock_connection":
      assertKeys(value, ["kind", "connectionId"], path);
      return { kind, connectionId: requiredString(value.connectionId, `${path}.connectionId`) };
    case "start_encounter":
      assertKeys(value, ["kind", "encounterId"], path);
      return { kind, encounterId: requiredString(value.encounterId, `${path}.encounterId`) };
    case "sanity_check":
      assertKeys(value, ["kind", "passLoss", "failLoss"], path);
      return { kind, passLoss: parseSanityLossSpec(value.passLoss, `${path}.passLoss`), failLoss: parseSanityLossSpec(value.failLoss, `${path}.failLoss`) };
    case "reward":
      assertKeys(value, ["kind", "rewardId"], path);
      return { kind, rewardId: requiredString(value.rewardId, `${path}.rewardId`) };
    case "end_game":
      assertKeys(value, ["kind", "endingId"], path);
      return { kind, endingId: requiredString(value.endingId, `${path}.endingId`) };
    default:
      throw new MechanicsCompilationError("invalid_schema", `unsupported effect kind: ${kind}`, undefined, `${path}.kind`);
  }
}

function parsePredicate(value: unknown, path: string): Predicate {
  if (!isRecord(value)) throw new MechanicsCompilationError("invalid_schema", `expected predicate object: ${path}`, undefined, path);
  const kind = requiredString(value.kind, `${path}.kind`);
  switch (kind) {
    case "all":
    case "any": {
      assertKeys(value, ["kind", "predicates"], path);
      if (!Array.isArray(value.predicates) || value.predicates.length === 0) throw new MechanicsCompilationError("invalid_schema", `empty ${kind} predicate: ${path}`, undefined, path);
      return { kind, predicates: value.predicates.map((entry, index) => parsePredicate(entry, `${path}.predicates[${index}]`)) };
    }
    case "not":
      assertKeys(value, ["kind", "predicate"], path);
      return { kind, predicate: parsePredicate(value.predicate, `${path}.predicate`) };
    case "clue_found":
      assertKeys(value, ["kind", "clueId"], path);
      return { kind, clueId: requiredString(value.clueId, `${path}.clueId`) };
    case "scene_visited":
      assertKeys(value, ["kind", "sceneId"], path);
      return { kind, sceneId: requiredString(value.sceneId, `${path}.sceneId`) };
    case "current_scene":
      assertKeys(value, ["kind", "sceneId"], path);
      return { kind, sceneId: requiredString(value.sceneId, `${path}.sceneId`) };
    case "item_owned":
      assertKeys(value, ["kind", "itemId"], path);
      return { kind, itemId: requiredString(value.itemId, `${path}.itemId`) };
    case "connection_unlocked":
      assertKeys(value, ["kind", "connectionId"], path);
      return { kind, connectionId: requiredString(value.connectionId, `${path}.connectionId`) };
    case "state_eq":
      assertKeys(value, ["kind", "stateKey", "value"], path);
      return { kind, stateKey: requiredString(value.stateKey, `${path}.stateKey`), value: scalar(value.value, `${path}.value`) };
    case "npc_state":
      assertKeys(value, ["kind", "npcId", "state"], path);
      return { kind, npcId: requiredString(value.npcId, `${path}.npcId`), state: requiredString(value.state, `${path}.state`) };
    case "encounter_defeated":
      assertKeys(value, ["kind", "encounterId"], path);
      return { kind, encounterId: requiredString(value.encounterId, `${path}.encounterId`) };
    default:
      throw new MechanicsCompilationError("invalid_schema", `unsupported predicate kind: ${kind}`, undefined, `${path}.kind`);
  }
}

function rewardPredicate(predicate: Predicate, path: string): RewardPredicate {
  switch (predicate.kind) {
    case "all":
    case "any":
      return { kind: predicate.kind, predicates: predicate.predicates.map((entry, index) => rewardPredicate(entry, `${path}.predicates[${index}]`)) };
    case "not": return { kind: "not", predicate: rewardPredicate(predicate.predicate, `${path}.predicate`) };
    case "clue_found": return predicate;
    case "scene_visited": return predicate;
    case "item_owned": return predicate;
    case "current_scene":
    case "connection_unlocked":
    case "state_eq":
    case "npc_state":
    case "encounter_defeated":
      throw new MechanicsCompilationError("invalid_reward_predicate", `reward condition uses unsupported predicate: ${predicate.kind}`, undefined, path);
  }
}

function parseRewardSettlement(value: unknown, path: string): RewardSettlement {
  if (!isRecord(value)) throw new MechanicsCompilationError("invalid_reward_settlement", `expected reward settlement object: ${path}`, undefined, path);
  assertKeys(value, ["san", "cthulhuMythos", "reputation"], path);
  const settlement: RewardSettlement = {};
  if (value.san !== undefined) {
    if (!isRecord(value.san)) throw new MechanicsCompilationError("invalid_reward_settlement", `expected SAN settlement object: ${path}.san`, undefined, `${path}.san`);
    const kind = requiredString(value.san.kind, `${path}.san.kind`);
    if (kind === "fixed") {
      assertKeys(value.san, ["kind", "amount"], `${path}.san`);
      const amount = value.san.amount;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > 100) throw new MechanicsCompilationError("invalid_reward_settlement", "SAN recovery must be a positive fixed amount no greater than 100", undefined, `${path}.san.amount`);
      settlement.san = { kind, amount };
    } else if (kind === "dice") {
      assertKeys(value.san, ["kind", "count", "sides"], `${path}.san`);
      const count = value.san.count;
      const sides = value.san.sides;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 100 || typeof sides !== "number" || !Number.isInteger(sides) || sides < 2 || sides > 100) {
        throw new MechanicsCompilationError("invalid_reward_settlement", "SAN dice must be bounded positive NdM", undefined, `${path}.san`);
      }
      settlement.san = { kind, count, sides };
    } else {
      throw new MechanicsCompilationError("invalid_reward_settlement", "unsupported SAN settlement kind", undefined, `${path}.san.kind`);
    }
  }
  for (const key of ["cthulhuMythos", "reputation"] as const) {
    const amount = value[key];
    if (amount === undefined) continue;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > 99) throw new MechanicsCompilationError("invalid_reward_settlement", `${key} must be a positive fixed amount no greater than 99`, undefined, `${path}.${key}`);
    settlement[key] = amount;
  }
  if (!settlement.san && settlement.cthulhuMythos === undefined && settlement.reputation === undefined) {
    throw new MechanicsCompilationError("invalid_reward_settlement", "reward settlement must grant SAN, Cthulhu Mythos, or reputation", undefined, path);
  }
  return settlement;
}

function parseCheck(value: unknown, path: string): CheckSpec {
  if (!isRecord(value)) throw new MechanicsCompilationError("invalid_schema", `expected check object: ${path}`, undefined, path);
  const kind = requiredString(value.kind, `${path}.kind`);
  if (kind === "none") {
    assertKeys(value, ["kind"], path);
    return { kind };
  }
  if (kind !== "skill" && kind !== "attribute") throw new MechanicsCompilationError("invalid_schema", `unsupported check kind: ${kind}`, undefined, `${path}.kind`);
  assertKeys(value, kind === "skill" ? ["kind", "skill", "difficulty"] : ["kind", "attribute", "difficulty"], path);
  const difficulty = requiredString(value.difficulty, `${path}.difficulty`);
  if (difficulty !== "regular" && difficulty !== "hard" && difficulty !== "extreme") throw new MechanicsCompilationError("invalid_schema", `unsupported difficulty: ${path}.difficulty`, undefined, `${path}.difficulty`);
  if (kind === "skill") return { kind, skill: requiredString(value.skill, `${path}.skill`), difficulty };
  const attribute = requiredString(value.attribute, `${path}.attribute`);
  if (!(["str", "dex", "pow", "con", "app", "edu", "int", "siz"] as string[]).includes(attribute)) {
    throw new MechanicsCompilationError("invalid_schema", `unsupported attribute: ${path}.attribute`, undefined, `${path}.attribute`);
  }
  return { kind, attribute: attribute as CheckSpec & { kind: "attribute" } extends { attribute: infer A } ? A : never, difficulty };
}

function parseActorEffectProvenance(value: unknown, path: string): ActorEffectProvenance[] {
  if (!Array.isArray(value) || value.length === 0) throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actorEffectProvenance must be a non-empty array", undefined, path);
  return value.map((entry, index) => {
    const record = isRecord(entry) ? entry : (() => { throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect provenance must be an object", undefined, `${path}[${index}]`); })();
    assertKeys(record, ["effectPath", "eventSlot", "source"], `${path}[${index}]`);
    const effectPath = requiredString(record.effectPath, `${path}[${index}].effectPath`);
    const event = isRecord(record.eventSlot) ? record.eventSlot : (() => { throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect eventSlot must be an object", undefined, `${path}[${index}].eventSlot`); })();
    const source = isRecord(record.source) ? record.source : (() => { throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect source must be an object", undefined, `${path}[${index}].source`); })();
    assertKeys(source, ["statementId", "quote"], `${path}[${index}].source`);
    const statementId = requiredString(source.statementId, `${path}[${index}].source.statementId`);
    const quote = requiredString(source.quote, `${path}[${index}].source.quote`);
    if (quote !== quote.trim()) throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect quote must be trimmed", undefined, `${path}[${index}].source.quote`);
    const kind = requiredString(event.kind, `${path}[${index}].eventSlot.kind`);
    const rawEffectIndex = event.effectIndex;
    if (!Number.isInteger(rawEffectIndex) || (rawEffectIndex as number) < 0) throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect index must be a non-negative integer", undefined, `${path}[${index}].eventSlot.effectIndex`);
    const effectIndex = rawEffectIndex as number;
    if (kind === "connection") {
      assertKeys(event, ["kind", "connectionId", "outcome", "effectIndex"], `${path}[${index}].eventSlot`);
      if (event.outcome !== "traverse") throw new MechanicsCompilationError("invalid_actor_effect_provenance", "connection actor effect must bind traverse", undefined, `${path}[${index}].eventSlot.outcome`);
      return { effectPath, eventSlot: { kind, connectionId: requiredString(event.connectionId, `${path}[${index}].eventSlot.connectionId`), outcome: "traverse", effectIndex }, source: { statementId, quote } };
    }
    if (kind === "discovery") {
      assertKeys(event, ["kind", "mechanismId", "outcome", "effectIndex"], `${path}[${index}].eventSlot`);
      const outcome = requiredString(event.outcome, `${path}[${index}].eventSlot.outcome`);
      if (outcome !== "success" && outcome !== "failure" && outcome !== "failback") throw new MechanicsCompilationError("invalid_actor_effect_provenance", "discovery actor effect has invalid outcome", undefined, `${path}[${index}].eventSlot.outcome`);
      return { effectPath, eventSlot: { kind, mechanismId: requiredString(event.mechanismId, `${path}[${index}].eventSlot.mechanismId`), outcome, effectIndex }, source: { statementId, quote } };
    }
    throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect eventSlot has invalid kind", undefined, `${path}[${index}].eventSlot.kind`);
  });
}

export function parseMechanicsCandidateSpec(value: unknown): MechanicsCandidateSpec {
  if (!isRecord(value)) throw new MechanicsCompilationError("invalid_schema", "mechanics candidate must be an object");
  const kind = requiredString(value.kind, "claim.value.kind");
  if (kind === "discovery_method") {
    assertKeys(value, ["kind", "id", "clueId", "action", "target", "targetId", "availability", "check", "onSuccess", "onFailure", "failback", "actorEffectProvenance"], "claim.value");
    const action = requiredString(value.action, "claim.value.action");
    const target = requiredString(value.target, "claim.value.target");
    if (!(["observe", "search", "talk", "read", "use_item", "move", "custom"] as string[]).includes(action)) throw new MechanicsCompilationError("invalid_schema", "unsupported discovery action", undefined, "claim.value.action");
    if (!(["clue", "item", "npc", "scene"] as string[]).includes(target)) throw new MechanicsCompilationError("invalid_schema", "unsupported discovery target", undefined, "claim.value.target");
    const failback = value.failback === undefined ? undefined : parseFailback(value.failback, "claim.value.failback");
    return {
      kind,
      id: requiredString(value.id, "claim.value.id"),
      clueId: requiredString(value.clueId, "claim.value.clueId"),
      action: action as DiscoveryAction,
      target: target as DiscoveryTarget,
      targetId: requiredString(value.targetId, "claim.value.targetId"),
      ...(value.availability === undefined ? {} : { availability: parsePredicate(value.availability, "claim.value.availability") }),
      ...(value.check === undefined ? {} : { check: parseCheck(value.check, "claim.value.check") }),
      onSuccess: requiredEffects(value.onSuccess, "claim.value.onSuccess"),
      ...(value.onFailure === undefined ? {} : { onFailure: requiredEffects(value.onFailure, "claim.value.onFailure") }),
      ...(failback ? { failback } : {}),
      ...(value.actorEffectProvenance === undefined ? {} : { actorEffectProvenance: parseActorEffectProvenance(value.actorEffectProvenance, "claim.value.actorEffectProvenance") }),
    };
  }
  if (kind === "connection_gate") {
    assertKeys(value, ["kind", "id", "connectionId", "availability", "onTraverse", "actorEffectProvenance"], "claim.value");
    return {
      kind,
      id: requiredString(value.id, "claim.value.id"),
      connectionId: requiredString(value.connectionId, "claim.value.connectionId"),
      ...(value.availability === undefined ? {} : { availability: parsePredicate(value.availability, "claim.value.availability") }),
      ...(value.onTraverse === undefined ? {} : { onTraverse: requiredEffects(value.onTraverse, "claim.value.onTraverse") }),
      ...(value.actorEffectProvenance === undefined ? {} : { actorEffectProvenance: parseActorEffectProvenance(value.actorEffectProvenance, "claim.value.actorEffectProvenance") }),
    };
  }
  if (kind === "state_transition") {
    assertKeys(value, ["kind", "id", "when", "effects"], "claim.value");
    return { kind, id: requiredString(value.id, "claim.value.id"), when: parsePredicate(value.when, "claim.value.when"), effects: requiredEffects(value.effects, "claim.value.effects") };
  }
  if (kind === "ending_rule") {
    assertKeys(value, ["kind", "id", "priority", "when", "effects"], "claim.value");
    if (typeof value.priority !== "number" || !Number.isInteger(value.priority)) throw new MechanicsCompilationError("invalid_schema", "ending priority must be an integer", undefined, "claim.value.priority");
    return { kind, id: requiredString(value.id, "claim.value.id"), priority: value.priority, when: parsePredicate(value.when, "claim.value.when"), effects: requiredEffects(value.effects, "claim.value.effects") };
  }
  if (kind === "encounter_definition") {
    assertKeys(value, ["kind", "id", "encounterId", "sceneId", "combatantId", "maxHp", "dodge", "fight", "npcDamage", "victoryEffects"], "claim.value");
    const maxHp = value.maxHp;
    const dodge = value.dodge;
    const fight = value.fight;
    if (typeof maxHp !== "number" || !Number.isInteger(maxHp) || maxHp < 1 || maxHp > 20) {
      throw new MechanicsCompilationError("invalid_encounter", "encounter maxHp must be an integer from 1 to 20", undefined, "claim.value.maxHp");
    }
    if (typeof dodge !== "number" || !Number.isInteger(dodge) || dodge < 0 || dodge > 100) {
      throw new MechanicsCompilationError("invalid_encounter", "encounter dodge must be an integer percentage from 0 to 100", undefined, "claim.value.dodge");
    }
    if (typeof fight !== "number" || !Number.isInteger(fight) || fight < 0 || fight > 100) {
      throw new MechanicsCompilationError("invalid_encounter", "encounter fight must be an integer percentage from 0 to 100", undefined, "claim.value.fight");
    }
    const id = requiredString(value.id, "claim.value.id");
    const encounterId = requiredString(value.encounterId, "claim.value.encounterId");
    if (id !== encounterId) throw new MechanicsCompilationError("invalid_encounter", "encounter definition id must equal encounterId", undefined, "claim.value.id");
    return {
      kind,
      id,
      encounterId,
      sceneId: requiredString(value.sceneId, "claim.value.sceneId"),
      combatantId: requiredString(value.combatantId, "claim.value.combatantId"),
      maxHp,
      dodge,
      fight,
      npcDamage: parseCombatDamageSpec(value.npcDamage, "claim.value.npcDamage"),
      victoryEffects: value.victoryEffects === undefined ? [] : requiredEffects(value.victoryEffects, "claim.value.victoryEffects", true),
    };
  }
  if (kind === "reward_definition") {
    assertKeys(value, ["kind", "id", "when", "settlement"], "claim.value");
    return {
      kind,
      id: requiredString(value.id, "claim.value.id"),
      when: rewardPredicate(parsePredicate(value.when, "claim.value.when"), "claim.value.when"),
      settlement: parseRewardSettlement(value.settlement, "claim.value.settlement"),
    };
  }
  throw new MechanicsCompilationError("invalid_schema", `unsupported mechanics kind: ${kind}`, undefined, "claim.value.kind");
}

function parseFailback(value: unknown, path: string): { maxFailures: number; effects: Effect[] } {
  if (!isRecord(value)) throw new MechanicsCompilationError("invalid_schema", `expected failback object: ${path}`, undefined, path);
  assertKeys(value, ["maxFailures", "effects"], path);
  if (typeof value.maxFailures !== "number" || !Number.isInteger(value.maxFailures) || value.maxFailures < 1) {
    throw new MechanicsCompilationError("invalid_schema", `failback maxFailures must be a positive integer: ${path}.maxFailures`, undefined, `${path}.maxFailures`);
  }
  return { maxFailures: value.maxFailures, effects: requiredEffects(value.effects, `${path}.effects`) };
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new MechanicsCompilationError("duplicate_id", `duplicate ${label}`);
}

function normalizeSymbols(symbols: MechanicsSymbols): MechanicsSymbols {
  const normalized: MechanicsSymbols = {
    clueIds: [...symbols.clueIds], sceneIds: [...symbols.sceneIds], itemIds: [...symbols.itemIds], npcIds: [...symbols.npcIds],
    connectionIds: [...symbols.connectionIds], encounterIds: [...symbols.encounterIds], endingIds: [...symbols.endingIds], rewardIds: [...symbols.rewardIds], declaredStateKeys: [...symbols.declaredStateKeys],
  };
  const symbolGroups: Array<[string, string[]]> = [
    ["clueIds", normalized.clueIds], ["sceneIds", normalized.sceneIds], ["itemIds", normalized.itemIds], ["npcIds", normalized.npcIds],
    ["connectionIds", normalized.connectionIds], ["encounterIds", normalized.encounterIds], ["endingIds", normalized.endingIds], ["rewardIds", normalized.rewardIds], ["declaredStateKeys", normalized.declaredStateKeys],
  ];
  for (const [label, values] of symbolGroups) {
    if (values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value))) throw new MechanicsCompilationError("invalid_symbol", `invalid ${label} symbol`);
    assertUnique(values, `${label} symbol`);
  }
  if (normalized.declaredStateKeys.some((key) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(key))) {
    throw new MechanicsCompilationError("invalid_symbol", "state keys must be declared identifiers");
  }
  return normalized;
}

/** Source graph identity is structural source evidence, independent of later interpretations. */
export function sourceFactGraphIdentity(graph: SourceFactGraph): string {
  return sha256(canonical({
    schemaVersion: graph.schemaVersion,
    documentIdentity: graph.documentIdentity,
    statements: graph.statements,
    relations: graph.relations,
  }));
}

type CompiledNode =
  | { kind: "discovery_method"; node: DiscoveryMethodIR }
  | { kind: "connection_gate"; node: ConnectionGateIR }
  | { kind: "state_transition"; node: StateTransitionIR }
  | { kind: "ending_rule"; node: EndingRuleIR }
  | { kind: "encounter_definition"; node: EncounterDefinitionIR }
  | { kind: "reward_definition"; node: RewardDefinitionIR };

function compileSpec(spec: MechanicsCandidateSpec, interpretationId: string): CompiledNode {
  const sourceInterpretationIds = [interpretationId];
  switch (spec.kind) {
    case "discovery_method": return { kind: spec.kind, node: { ...spec, sourceInterpretationIds } };
    case "connection_gate": return { kind: spec.kind, node: { ...spec, sourceInterpretationIds } };
    case "state_transition": return { kind: spec.kind, node: { ...spec, sourceInterpretationIds } };
    case "ending_rule": return { kind: spec.kind, node: { ...spec, sourceInterpretationIds } };
    case "encounter_definition": {
      const { kind: _kind, ...definition } = spec;
      return { kind: spec.kind, node: { ...definition, sourceInterpretationIds } };
    }
    case "reward_definition": return { kind: spec.kind, node: { ...spec, sourceInterpretationIds } };
  }
}

const ACCEPTED_AUTHORITIES = new Set(["module_errata", "module_explicit", "user_document", "open_licensed", "project_original"]);

function eligibleInterpretation(graph: SourceFactGraph, interpretationId: string, input: Pick<MechanicsCompilationInput, "moduleId" | "compilationMode" | "allowedEnginePolicyIds">): FactInterpretationCandidate {
  const interpretation = graph.interpretations.find((candidate) => candidate.id === interpretationId);
  if (!interpretation) throw new MechanicsCompilationError("missing_interpretation", `interpretation is missing: ${interpretationId}`, interpretationId);
  const claim = interpretation.claim;
  if (!claim.scope.moduleId || claim.scope.moduleId !== input.moduleId) throw new MechanicsCompilationError("scope_mismatch", `interpretation scope is outside module: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
  if (interpretation.interpretationStatus !== "accepted" || claim.status !== "accepted") {
    throw new MechanicsCompilationError("interpretation_not_accepted", `interpretation is not accepted: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
  }
  if (interpretation.sourceStatementIds.length === 0) throw new MechanicsCompilationError("missing_source", `interpretation has no source statements: ${interpretationId}`, interpretationId);
  if (claim.domain !== "gameplay_mechanic") throw new MechanicsCompilationError("invalid_domain", `interpretation is not a gameplay mechanic: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
  if (claim.authority === "engine_policy") {
    if ((input.compilationMode ?? "strict") !== "compatible") throw new MechanicsCompilationError("engine_policy_strict", `strict mode rejects engine policy: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
    if (claim.derivation !== "default") throw new MechanicsCompilationError("engine_policy_derivation", `engine policy must be a default: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
    if (interpretation.review?.decision !== "accept" || interpretation.review.reviewerKind !== "approved_policy") {
      throw new MechanicsCompilationError("engine_policy_review", `engine policy lacks approved policy review: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
    }
    if (!interpretation.review.policyId || !input.allowedEnginePolicyIds?.includes(interpretation.review.policyId)) {
      throw new MechanicsCompilationError("engine_policy_not_allowed", `engine policy is not allowed: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
    }
    if (graph.interpretations.some((candidate) => candidate.id !== interpretation.id && candidate.interpretationStatus === "accepted" && candidate.claim.status === "accepted" && candidate.claim.authority === "module_explicit" && candidate.claim.scope.moduleId === input.moduleId && candidate.claim.domain === "gameplay_mechanic" && candidate.claim.path === claim.path)) {
      throw new MechanicsCompilationError("engine_policy_override", `engine policy cannot override module explicit mechanic: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
    }
    if (!claim.path.startsWith("mechanics.")) throw new MechanicsCompilationError("invalid_path", `mechanics claim path is required: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
    return interpretation;
  }
  if (!ACCEPTED_AUTHORITIES.has(claim.authority)) throw new MechanicsCompilationError("invalid_authority", `interpretation authority is not allowed: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
  if (!claim.path.startsWith("mechanics.")) throw new MechanicsCompilationError("invalid_path", `mechanics claim path is required: ${interpretationId}`, interpretationId, claim.path, interpretation.sourceStatementIds);
  return interpretation;
}

function validateActorEffectProvenanceSource(graph: SourceFactGraph, interpretation: FactInterpretationCandidate, spec: MechanicsCandidateSpec): void {
  const provenance = spec.kind === "connection_gate" || spec.kind === "discovery_method"
    ? spec.actorEffectProvenance ?? []
    : [];
  for (const [index, binding] of provenance.entries()) {
    const path = `claim.value.actorEffectProvenance[${index}].source`;
    if (!interpretation.sourceStatementIds.includes(binding.source.statementId)) {
      throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect source statement is outside its interpretation evidence", interpretation.id, path, interpretation.sourceStatementIds);
    }
    const statement = graph.statements.find((candidate) => candidate.id === binding.source.statementId);
    if (!statement) {
      throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect source statement is missing from SourceFactGraph", interpretation.id, path, interpretation.sourceStatementIds);
    }
    const first = statement.text.indexOf(binding.source.quote);
    if (first < 0 || first !== statement.text.lastIndexOf(binding.source.quote)) {
      throw new MechanicsCompilationError("invalid_actor_effect_provenance", "actor effect quote must be a unique exact source substring", interpretation.id, `${path}.quote`, interpretation.sourceStatementIds);
    }
  }
}

/** Audit a candidate without validating references against the final runtime symbols. */
export function validateMechanicsCandidate(graph: SourceFactGraph, interpretationId: string, input: Pick<MechanicsCompilationInput, "moduleId" | "compilationMode" | "allowedEnginePolicyIds">): MechanicsCandidateSpec {
  const interpretation = eligibleInterpretation(graph, interpretationId, input);
  try {
    const spec = parseMechanicsCandidateSpec(interpretation.claim.value);
    validateActorEffectProvenanceSource(graph, interpretation, spec);
    return spec;
  } catch (error) {
    if (error instanceof MechanicsCompilationError) throw new MechanicsCompilationError(error.code, error.reason, interpretation.id, error.path ?? interpretation.claim.path, interpretation.sourceStatementIds);
    throw error;
  }
}

export function compileMechanics(graph: SourceFactGraph, input: MechanicsCompilationInput): MechanicsIR {
  validateSourceFactGraph(graph);
  if (!input.moduleId.trim()) throw new MechanicsCompilationError("invalid_input", "moduleId is required");
  if (input.documentHash !== graph.documentIdentity.documentHash) throw new MechanicsCompilationError("document_mismatch", "documentHash does not match SourceFactGraph");
  if (input.sourceGraphSchemaVersion !== graph.schemaVersion) throw new MechanicsCompilationError("schema_mismatch", "sourceGraphSchemaVersion does not match SourceFactGraph");
  if (input.compilationMode && input.compilationMode !== "strict" && input.compilationMode !== "compatible") throw new MechanicsCompilationError("invalid_input", "unknown compilationMode");
  assertUnique(input.acceptedInterpretationIds, "accepted interpretation id");
  if (input.allowedEnginePolicyIds) assertUnique(input.allowedEnginePolicyIds, "allowed engine policy id");
  if (input.requiredMechanicIds) assertUnique(input.requiredMechanicIds, "required mechanic id");
  const symbols = normalizeSymbols(input.symbols);
  const nodes = input.acceptedInterpretationIds.map((interpretationId) => {
    return compileSpec(validateMechanicsCandidate(graph, interpretationId, input), interpretationId);
  });
  const ir: MechanicsIR = {
    schemaVersion: MECHANICS_IR_SCHEMA_VERSION,
    moduleId: input.moduleId,
    documentHash: input.documentHash,
    sourceGraphIdentity: sourceFactGraphIdentity(graph),
    mechanicsHash: "",
    symbols,
    sourceInterpretationIds: [...input.acceptedInterpretationIds].sort(),
    discoveryMethods: nodes.filter((node): node is Extract<CompiledNode, { kind: "discovery_method" }> => node.kind === "discovery_method").map((node) => node.node).sort((left, right) => left.id.localeCompare(right.id)),
    connections: nodes.filter((node): node is Extract<CompiledNode, { kind: "connection_gate" }> => node.kind === "connection_gate").map((node) => node.node).sort((left, right) => left.id.localeCompare(right.id)),
    transitions: nodes.filter((node): node is Extract<CompiledNode, { kind: "state_transition" }> => node.kind === "state_transition").map((node) => node.node).sort((left, right) => left.id.localeCompare(right.id)),
    endings: nodes.filter((node): node is Extract<CompiledNode, { kind: "ending_rule" }> => node.kind === "ending_rule").map((node) => node.node).sort((left, right) => left.id.localeCompare(right.id)),
    encounterDefinitions: nodes.filter((node): node is Extract<CompiledNode, { kind: "encounter_definition" }> => node.kind === "encounter_definition").map((node) => node.node).sort((left, right) => left.encounterId.localeCompare(right.encounterId)),
    rewards: nodes.filter((node): node is Extract<CompiledNode, { kind: "reward_definition" }> => node.kind === "reward_definition").map((node) => node.node).sort((left, right) => left.id.localeCompare(right.id)),
  };
  validateMechanicsStructure(ir);
  if (input.requiredMechanicIds) {
    const compiled = new Set([...ir.discoveryMethods, ...ir.connections, ...ir.transitions, ...ir.endings, ...ir.encounterDefinitions, ...ir.rewards].map((node) => node.id));
    for (const id of input.requiredMechanicIds) if (!compiled.has(id)) throw new MechanicsCompilationError("missing_required_mechanic", `required mechanic is missing: ${id}`);
  }
  const mechanicsHash = sha256(canonical({ ...ir, mechanicsHash: undefined }));
  const completed = { ...ir, mechanicsHash };
  validateMechanicsIR(completed);
  return completed;
}

function assertKnown(id: string, ids: readonly string[], label: string): void {
  if (!ids.includes(id)) throw new MechanicsCompilationError("unknown_symbol", `unknown ${label}: ${id}`);
}

function validatePredicate(predicate: Predicate, symbols: MechanicsSymbols): void {
  switch (predicate.kind) {
    case "all":
    case "any":
      if (predicate.predicates.length === 0) throw new MechanicsCompilationError("invalid_predicate", `empty ${predicate.kind} predicate`);
      predicate.predicates.forEach((entry) => validatePredicate(entry, symbols));
      return;
    case "not": validatePredicate(predicate.predicate, symbols); return;
    case "clue_found": assertKnown(predicate.clueId, symbols.clueIds, "clue"); return;
    case "scene_visited": assertKnown(predicate.sceneId, symbols.sceneIds, "scene"); return;
    case "current_scene": assertKnown(predicate.sceneId, symbols.sceneIds, "scene"); return;
    case "item_owned": assertKnown(predicate.itemId, symbols.itemIds, "item"); return;
    case "connection_unlocked": assertKnown(predicate.connectionId, symbols.connectionIds, "connection"); return;
    case "state_eq": assertKnown(predicate.stateKey, symbols.declaredStateKeys, "state key"); return;
    case "npc_state": assertKnown(predicate.npcId, symbols.npcIds, "npc"); return;
    case "encounter_defeated": assertKnown(predicate.encounterId, symbols.encounterIds, "encounter"); return;
  }
}

function validateCombatDamageSpec(spec: CombatDamageSpec): void {
  if (spec.kind === "fixed") {
    if (!Number.isInteger(spec.amount) || spec.amount < 1 || spec.amount > 20) throw new MechanicsCompilationError("invalid_combat_damage", "invalid fixed combat damage");
    return;
  }
  if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 3 || !Number.isInteger(spec.sides) || spec.sides < 2 || spec.sides > 10 || spec.count * spec.sides > 20) {
    throw new MechanicsCompilationError("invalid_combat_damage", "invalid combat dice damage");
  }
}

function validateEffects(effects: readonly Effect[], symbols: MechanicsSymbols, allowEndGame: boolean, allowActorEffects: boolean, allowEmpty = false): void {
  if (effects.length === 0 && !allowEmpty) throw new MechanicsCompilationError("invalid_effect", "effects must not be empty");
  if (effects.length > 100) throw new MechanicsCompilationError("invalid_effect", "too many effects in one player/automatic branch");
  const writes = new Map<string, string>();
  let maximumActorLoss = 0;
  for (const effect of effects) {
    switch (effect.kind) {
      case "discover_clue": assertKnown(effect.clueId, symbols.clueIds, "clue"); break;
      case "acquire_item": assertKnown(effect.itemId, symbols.itemIds, "item"); break;
      case "set_state": {
        assertKnown(effect.stateKey, symbols.declaredStateKeys, "state key");
        const previous = writes.get(effect.stateKey);
        const value = canonical(effect.value);
        if (previous !== undefined && previous !== value) throw new MechanicsCompilationError("conflicting_state_write", `mutually exclusive state values for ${effect.stateKey}`);
        writes.set(effect.stateKey, value);
        break;
      }
      case "unlock_connection": assertKnown(effect.connectionId, symbols.connectionIds, "connection"); break;
      case "start_encounter": assertKnown(effect.encounterId, symbols.encounterIds, "encounter"); break;
      case "sanity_check":
        if (!allowActorEffects) throw new MechanicsCompilationError("invalid_actor_effect", "sanity_check is only allowed in a discovery action branch or connection traversal", undefined);
        // Parsed IR can be supplied directly to validateMechanicsIR, so retain the
        // same fail-closed bounds independently of the JSON parser.
        for (const [label, loss] of [["passLoss", effect.passLoss], ["failLoss", effect.failLoss]] as const) {
          if (loss.kind === "fixed") {
            if (!Number.isInteger(loss.amount) || loss.amount < 0 || loss.amount > 100) throw new MechanicsCompilationError("invalid_sanity_loss", `invalid ${label} fixed SAN loss`);
          } else if (!Number.isInteger(loss.count) || loss.count < 1 || loss.count > 10 || !Number.isInteger(loss.sides) || loss.sides < 2 || loss.sides > 100 || loss.count * loss.sides > 100) {
            throw new MechanicsCompilationError("invalid_sanity_loss", `invalid ${label} SAN dice loss`);
          }
        }
        maximumActorLoss += Math.max(
          effect.passLoss.kind === "fixed" ? effect.passLoss.amount : effect.passLoss.count * effect.passLoss.sides,
          effect.failLoss.kind === "fixed" ? effect.failLoss.amount : effect.failLoss.count * effect.failLoss.sides,
        );
        break;
      case "reward":
        throw new MechanicsCompilationError("invalid_reward_effect", "reward effects are not supported; declare a source-bound reward_definition instead");
      case "end_game":
        if (!allowEndGame) throw new MechanicsCompilationError("invalid_end_game", "end_game is only allowed in an ending or explicit terminal transition");
        assertKnown(effect.endingId, symbols.endingIds, "ending");
        break;
    }
  }
  if (maximumActorLoss > 100) throw new MechanicsCompilationError("invalid_sanity_loss", "one player action cannot declare more than 100 possible SAN loss");
}

function validateRewardPredicate(predicate: RewardPredicate, symbols: MechanicsSymbols): void {
  switch (predicate.kind) {
    case "all":
    case "any":
      if (predicate.predicates.length === 0) throw new MechanicsCompilationError("invalid_reward_predicate", `empty ${predicate.kind} reward predicate`);
      predicate.predicates.forEach((entry) => validateRewardPredicate(entry, symbols));
      return;
    case "not": validateRewardPredicate(predicate.predicate, symbols); return;
    case "clue_found": assertKnown(predicate.clueId, symbols.clueIds, "clue"); return;
    case "scene_visited": assertKnown(predicate.sceneId, symbols.sceneIds, "scene"); return;
    case "item_owned": assertKnown(predicate.itemId, symbols.itemIds, "item"); return;
  }
}

function validateSourceIds(ids: readonly string[], available: readonly string[]): void {
  if (ids.length === 0) throw new MechanicsCompilationError("missing_source", "mechanic lacks sourceInterpretationIds");
  assertUnique(ids, "source interpretation id");
  for (const id of ids) assertKnown(id, available, "source interpretation");
}

type ActorEffectBranch = { outcome: "success" | "failure" | "failback" | "traverse"; path: "onSuccess" | "onFailure" | "failback.effects" | "onTraverse"; effects: readonly Effect[] };

function validateActorEffectProvenance(
  mechanic: Pick<DiscoveryMethodIR, "id" | "onSuccess" | "onFailure" | "failback" | "actorEffectProvenance"> | Pick<ConnectionGateIR, "id" | "connectionId" | "onTraverse" | "actorEffectProvenance">,
): void {
  const connection = "connectionId" in mechanic;
  const branches: ActorEffectBranch[] = connection
    ? [{ outcome: "traverse", path: "onTraverse", effects: mechanic.onTraverse ?? [] }]
    : [
      { outcome: "success", path: "onSuccess", effects: mechanic.onSuccess },
      { outcome: "failure", path: "onFailure", effects: mechanic.onFailure ?? [] },
      { outcome: "failback", path: "failback.effects", effects: mechanic.failback?.effects ?? [] },
    ];
  const slots = branches.flatMap((branch) => branch.effects.flatMap((effect, effectIndex) => effect.kind === "sanity_check"
    ? [{ branch, effectIndex, effectPath: `${branch.path}[${effectIndex}]` }]
    : []));
  const provenance = mechanic.actorEffectProvenance;
  if (slots.length === 0) {
    if (provenance !== undefined) throw new MechanicsCompilationError("invalid_actor_effect_provenance", `mechanic ${mechanic.id} has SAN provenance without a SAN effect`);
    return;
  }
  if (!provenance || provenance.length !== slots.length) throw new MechanicsCompilationError("missing_actor_effect_provenance", `every SAN effect slot requires exactly one actor provenance binding: ${mechanic.id}`);
  const bound = new Set<string>();
  for (const binding of provenance) {
    const slot = slots.find((candidate) => candidate.branch.outcome === binding.eventSlot.outcome && candidate.effectIndex === binding.eventSlot.effectIndex);
    if (!slot || binding.effectPath !== slot.effectPath) {
      throw new MechanicsCompilationError("invalid_actor_effect_provenance", `actor effect provenance does not name an exact SAN slot: ${mechanic.id}`);
    }
    if (connection) {
      if (binding.eventSlot.kind !== "connection" || binding.eventSlot.connectionId !== mechanic.connectionId || binding.eventSlot.outcome !== "traverse") {
        throw new MechanicsCompilationError("invalid_actor_effect_provenance", `actor effect provenance does not match connection traversal: ${mechanic.id}`);
      }
    } else if (binding.eventSlot.kind !== "discovery" || binding.eventSlot.mechanismId !== mechanic.id) {
      throw new MechanicsCompilationError("invalid_actor_effect_provenance", `actor effect provenance does not match discovery branch: ${mechanic.id}`);
    }
    const key = `${binding.eventSlot.kind}:${binding.eventSlot.outcome}:${binding.eventSlot.effectIndex}`;
    if (bound.has(key)) throw new MechanicsCompilationError("invalid_actor_effect_provenance", `actor effect provenance duplicates a SAN slot: ${mechanic.id}`);
    bound.add(key);
  }
}

function validateMechanicsStructure(ir: MechanicsIR): void {
  assertKeys(ir as unknown as RecordValue, ["schemaVersion", "moduleId", "documentHash", "sourceGraphIdentity", "mechanicsHash", "symbols", "sourceInterpretationIds", "discoveryMethods", "connections", "transitions", "endings", "encounterDefinitions", "rewards"], "mechanicsIR");
  if (ir.schemaVersion !== MECHANICS_IR_SCHEMA_VERSION) throw new MechanicsCompilationError("schema_mismatch", `unsupported mechanics schema: ${ir.schemaVersion}`);
  if (!ir.moduleId.trim() || !ir.sourceGraphIdentity || !/^[a-f0-9]{64}$/.test(ir.sourceGraphIdentity)) throw new MechanicsCompilationError("invalid_identity", "invalid mechanics identity");
  const symbols = normalizeSymbols(ir.symbols);
  const sourceIds = [...ir.sourceInterpretationIds];
  assertUnique(sourceIds, "source interpretation id");
  const allNodes = [...ir.discoveryMethods, ...ir.connections, ...ir.transitions, ...ir.endings, ...ir.encounterDefinitions, ...ir.rewards];
  const nodeIds = allNodes.map((node) => node.id);
  assertUnique(nodeIds, "mechanism id");
  for (const discovery of ir.discoveryMethods) {
    assertKnown(discovery.clueId, symbols.clueIds, "clue");
    assertKnown(discovery.targetId, discovery.target === "clue" ? symbols.clueIds : discovery.target === "item" ? symbols.itemIds : discovery.target === "npc" ? symbols.npcIds : symbols.sceneIds, `${discovery.target} target`);
    if ((discovery.action === "talk") !== (discovery.target === "npc")) {
      throw new MechanicsCompilationError("invalid_discovery_actor", "talk discovery actions must target NPCs, and NPC discoveries must use talk", undefined);
    }
    if (!discovery.onSuccess.some((effect) => effect.kind === "discover_clue" && effect.clueId === discovery.clueId)) throw new MechanicsCompilationError("missing_discovery_effect", `discovery method must discover its clue: ${discovery.id}`);
    if (discovery.target === "item" && !discovery.onSuccess.some((effect) => effect.kind === "acquire_item" && effect.itemId === discovery.targetId)) {
      throw new MechanicsCompilationError("missing_item_acquire_effect", `item discovery must acquire its target item: ${discovery.id}`);
    }
    if (discovery.availability) validatePredicate(discovery.availability, symbols);
    if (discovery.onFailure) validateEffects(discovery.onFailure, symbols, false, true);
    if (discovery.failback) validateEffects(discovery.failback.effects, symbols, false, true);
    validateEffects(discovery.onSuccess, symbols, false, true);
    validateActorEffectProvenance(discovery);
    validateSourceIds(discovery.sourceInterpretationIds, sourceIds);
  }
  for (const connection of ir.connections) {
    assertKnown(connection.connectionId, symbols.connectionIds, "connection");
    if (connection.availability) validatePredicate(connection.availability, symbols);
    if (connection.onTraverse) validateEffects(connection.onTraverse, symbols, false, true);
    validateActorEffectProvenance(connection);
    validateSourceIds(connection.sourceInterpretationIds, sourceIds);
  }
  assertUnique(ir.connections.map((connection) => connection.connectionId), "connection gate");
  for (const transition of ir.transitions) {
    validatePredicate(transition.when, symbols);
    validateEffects(transition.effects, symbols, true, false);
    validateSourceIds(transition.sourceInterpretationIds, sourceIds);
  }
  const priorities = new Set<number>();
  for (const ending of ir.endings) {
    if (priorities.has(ending.priority)) throw new MechanicsCompilationError("duplicate_ending_priority", `duplicate ending priority: ${ending.priority}`);
    priorities.add(ending.priority);
    validatePredicate(ending.when, symbols);
    validateEffects(ending.effects, symbols, true, false);
    const endGames = ending.effects.filter((effect) => effect.kind === "end_game");
    if (endGames.length !== 1) throw new MechanicsCompilationError("invalid_ending_rule", `ending rule must declare exactly one end_game effect: ${ending.id}`);
    validateSourceIds(ending.sourceInterpretationIds, sourceIds);
  }
  const encounterIds = ir.encounterDefinitions.map((definition) => definition.encounterId);
  assertUnique(encounterIds, "encounter definition");
  if (encounterIds.length !== symbols.encounterIds.length || encounterIds.some((id) => !symbols.encounterIds.includes(id)) || symbols.encounterIds.some((id) => !encounterIds.includes(id))) {
    throw new MechanicsCompilationError("encounter_catalog_mismatch", "encounter symbols and source-bound encounter definitions must match exactly");
  }
  for (const definition of ir.encounterDefinitions) {
    assertKeys(definition as unknown as RecordValue, ["id", "encounterId", "sceneId", "combatantId", "maxHp", "dodge", "fight", "npcDamage", "victoryEffects", "sourceInterpretationIds"], `encounterDefinitions.${definition.encounterId}`);
    if (definition.id !== definition.encounterId) throw new MechanicsCompilationError("invalid_encounter", "encounter definition id must equal encounterId");
    assertKnown(definition.sceneId, symbols.sceneIds, "encounter scene");
    assertKnown(definition.combatantId, symbols.npcIds, "encounter combatant");
    if (!Number.isInteger(definition.maxHp) || definition.maxHp < 1 || definition.maxHp > 20) throw new MechanicsCompilationError("invalid_encounter", "encounter maxHp must be an integer from 1 to 20");
    if (!Number.isInteger(definition.dodge) || definition.dodge < 0 || definition.dodge > 100 || !Number.isInteger(definition.fight) || definition.fight < 0 || definition.fight > 100) {
      throw new MechanicsCompilationError("invalid_encounter", "encounter dodge and fight must be integer percentages from 0 to 100");
    }
    validateCombatDamageSpec(definition.npcDamage);
    validateEffects(definition.victoryEffects, symbols, false, false, true);
    if (definition.victoryEffects.some((effect) => effect.kind === "start_encounter")) throw new MechanicsCompilationError("invalid_encounter", "victory effects cannot start another encounter");
    validateSourceIds(definition.sourceInterpretationIds, sourceIds);
  }
  const rewardIds = ir.rewards.map((reward) => reward.id);
  assertUnique(rewardIds, "reward definition");
  if (rewardIds.length !== symbols.rewardIds.length || rewardIds.some((id) => !symbols.rewardIds.includes(id)) || symbols.rewardIds.some((id) => !rewardIds.includes(id))) {
    throw new MechanicsCompilationError("reward_catalog_mismatch", "reward symbols and source-bound reward definitions must match exactly");
  }
  for (const reward of ir.rewards) {
    validateRewardPredicate(reward.when, symbols);
    validateSourceIds(reward.sourceInterpretationIds, sourceIds);
  }
}

export function validateMechanicsIR(ir: MechanicsIR): void {
  validateMechanicsStructure(ir);
  const expected = sha256(canonical({ ...ir, mechanicsHash: undefined }));
  if (ir.mechanicsHash !== expected) throw new MechanicsCompilationError("hash_mismatch", "mechanicsHash does not match canonical IR");
}
