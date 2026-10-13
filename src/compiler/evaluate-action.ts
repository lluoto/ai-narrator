import {
  executeMechanicsAction,
  initialMechanicsState,
  mechanicsStateHash,
  MechanicsReachabilityError,
  settleAutomaticMechanics,
  settleInitialMechanics,
  validateMechanicsAnalysisInput,
  type MechanicsActionRequest,
  type MechanicsAnalysisInput,
  type MechanicsReachabilityEdge,
  type MechanicsState,
  type SelectedActorEffect,
} from "./mechanics-execution";
import type { MechanicsIR } from "./mechanics-ir";

export interface EvaluateActionInput {
  readonly mechanicsIR: MechanicsIR;
  readonly analysisInput: MechanicsAnalysisInput;
  readonly requestedAction: MechanicsActionRequest;
}

/** One entry-state action evaluation with its complete shared-core edge trace. */
export interface EvaluateActionResult {
  readonly finalState: MechanicsState;
  readonly requestedAction: MechanicsActionRequest;
  readonly trace: readonly MechanicsReachabilityEdge[];
  /** Actor-owned effects selected by the action and deliberately not settled here. */
  readonly unresolvedActorEffects: readonly SelectedActorEffect[];
  /** Hash of the raw entry state before initial automatic settlement. */
  readonly beforeStateHash: string;
  /** Hash of finalState after the requested action and post-action settlement. */
  readonly afterStateHash: string;
}

type UnknownRecord = Record<string, unknown>;

function inputError(message: string): never {
  throw new MechanicsReachabilityError("invalid_evaluate_action_input", `invalid evaluate action input: ${message}`);
}

function plainRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    inputError(`${label} must be an object`);
  }
  const record = value as UnknownRecord;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    inputError(`${label} must be a plain object`);
  }
  return record;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  const record = plainRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    inputError(`${label} has unexpected fields`);
  }
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    inputError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") inputError(`${label} must be a boolean`);
  return value;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    inputError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function validateRequestedAction(value: unknown): MechanicsActionRequest {
  const action = plainRecord(value, "requestedAction");
  const mechanismId = requiredString(action.mechanismId, "requestedAction.mechanismId");
  const outcome = action.outcome;
  if (outcome === "success" || outcome === "failure" || outcome === "failback" || outcome === "traverse") {
    exactRecord(action, ["mechanismId", "outcome"], "requestedAction");
    return { mechanismId, outcome };
  }
  if (outcome !== "attack") inputError("requestedAction.outcome is unsupported");
  exactRecord(action, ["mechanismId", "outcome", "combat"], "requestedAction");
  const combat = exactRecord(action.combat, ["kind", "encounterId", "targetId", "hit", "damage", "enemyHit", "actorDamage", "actorDefeated"], "requestedAction.combat");
  if (combat.kind !== "attack") inputError("requestedAction.combat.kind must be attack");
  const encounterId = requiredString(combat.encounterId, "requestedAction.combat.encounterId");
  const targetId = requiredString(combat.targetId, "requestedAction.combat.targetId");
  const hit = requiredBoolean(combat.hit, "requestedAction.combat.hit");
  const damage = requiredNonNegativeInteger(combat.damage, "requestedAction.combat.damage");
  const enemyHit = requiredBoolean(combat.enemyHit, "requestedAction.combat.enemyHit");
  const actorDamage = requiredNonNegativeInteger(combat.actorDamage, "requestedAction.combat.actorDamage");
  const actorDefeated = requiredBoolean(combat.actorDefeated, "requestedAction.combat.actorDefeated");
  return {
    mechanismId,
    outcome,
    combat: hit ? {
      kind: "attack",
      encounterId,
      targetId,
      hit: true,
      damage,
      enemyHit,
      actorDamage,
      actorDefeated,
    } : {
      kind: "attack",
      encounterId,
      targetId,
      hit: false,
      // The shared core, not this parser, rejects a forged nonzero miss.
      damage: damage as 0,
      enemyHit,
      actorDamage,
      actorDefeated,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return Object.freeze(value);
}

/**
 * Evaluates exactly one declared action from the MechanicsAnalysisInput entry
 * state. Automatic settlement occurs before and after that action; all core
 * failures deliberately propagate unchanged.
 */
export function evaluateAction(input: EvaluateActionInput): EvaluateActionResult;
export function evaluateAction(input: unknown): EvaluateActionResult;
export function evaluateAction(input: unknown): EvaluateActionResult {
  const record = exactRecord(input, ["mechanicsIR", "analysisInput", "requestedAction"], "input");
  const mechanicsIR = plainRecord(record.mechanicsIR, "mechanicsIR") as unknown as MechanicsIR;
  const analysisInput = plainRecord(record.analysisInput, "analysisInput") as unknown as MechanicsAnalysisInput;
  const requestedAction = validateRequestedAction(record.requestedAction);

  validateMechanicsAnalysisInput(mechanicsIR, analysisInput);
  const initial = initialMechanicsState(analysisInput);
  const beforeStateHash = mechanicsStateHash(initial);
  const settledInitial = settleInitialMechanics(mechanicsIR, analysisInput);
  const executed = executeMechanicsAction(mechanicsIR, analysisInput, settledInitial.state, requestedAction);
  const settledFinal = settleAutomaticMechanics(mechanicsIR, executed.state);
  const finalState = settledFinal.state;
  const result: EvaluateActionResult = {
    finalState,
    requestedAction,
    trace: [...settledInitial.steps, executed.edge, ...settledFinal.steps],
    unresolvedActorEffects: executed.actorEffects,
    beforeStateHash,
    afterStateHash: mechanicsStateHash(finalState),
  };
  return deepFreeze(structuredClone(result));
}
