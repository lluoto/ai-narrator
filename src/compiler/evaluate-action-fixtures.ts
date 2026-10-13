import { evaluateAction, type EvaluateActionResult } from "./evaluate-action";
import {
  initialMechanicsState,
  mechanicsStateHash,
  MechanicsReachabilityError,
  type MechanicsActionRequest,
  type MechanicsAnalysisInput,
  type MechanicsOutcome,
  type MechanicsReachabilityEdge,
  type MechanicsState,
} from "./mechanics-execution";
import type { MechanicsIR } from "./mechanics-ir";
import { replayMechanicsWitness, type MechanicsWitness } from "./mechanics-reachability";

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export interface EvaluateActionFixtureExpectedEdge {
  readonly mechanismId: string;
  readonly outcome: MechanicsOutcome;
}

/** Explicit, stable assertions for one entry-state action evaluation. */
export interface EvaluateActionFixtureExpectation {
  readonly afterStateHash: string;
  readonly trace: NonEmptyReadonlyArray<EvaluateActionFixtureExpectedEdge>;
}

export interface EvaluateActionFixtureCase {
  readonly id: string;
  readonly requestedAction: MechanicsActionRequest;
  readonly expected: EvaluateActionFixtureExpectation;
}

/** Each key is an input fixture ID and each value is its verified evaluator result. */
export type EvaluateActionFixtureReport = Readonly<Record<string, EvaluateActionResult>>;

type UnknownRecord = Record<string, unknown>;

interface ParsedFixtureCase {
  readonly id: string;
  readonly requestedAction: MechanicsActionRequest;
  readonly expected: {
    readonly afterStateHash: string;
    readonly trace: readonly EvaluateActionFixtureExpectedEdge[];
  };
}

const MECHANICS_OUTCOMES: readonly MechanicsOutcome[] = ["success", "failure", "failback", "traverse", "transition", "ending", "attack"];

function fixtureInputError(message: string): never {
  throw new MechanicsReachabilityError("invalid_evaluate_action_fixture", `invalid evaluate action fixture: ${message}`);
}

function fixtureMismatch(id: string, message: string): never {
  throw new MechanicsReachabilityError("evaluate_action_fixture_mismatch", `evaluate action fixture ${id}: ${message}`);
}

function plainRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fixtureInputError(`${label} must be a plain object`);
  const record = value as UnknownRecord;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) fixtureInputError(`${label} must be a plain object`);
  return record;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  const record = plainRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fixtureInputError(`${label} has unexpected fields`);
  }
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fixtureInputError(`${label} must be a non-empty string`);
  return value;
}

function requiredOutcome(value: unknown, label: string): MechanicsOutcome {
  if (typeof value !== "string" || !MECHANICS_OUTCOMES.includes(value as MechanicsOutcome)) {
    fixtureInputError(`${label} is unsupported`);
  }
  return value as MechanicsOutcome;
}

function parseFixtureCase(value: unknown, index: number): ParsedFixtureCase {
  const label = `fixtures[${index}]`;
  const record = exactRecord(value, ["id", "requestedAction", "expected"], label);
  const id = requiredString(record.id, `${label}.id`);
  const expectedRecord = exactRecord(record.expected, ["afterStateHash", "trace"], `${label}.expected`);
  const afterStateHash = requiredString(expectedRecord.afterStateHash, `${label}.expected.afterStateHash`);
  if (!Array.isArray(expectedRecord.trace) || expectedRecord.trace.length === 0) {
    fixtureInputError(`${label}.expected.trace must be a non-empty array`);
  }
  const trace = expectedRecord.trace.map((edge, edgeIndex) => {
    const edgeLabel = `${label}.expected.trace[${edgeIndex}]`;
    const edgeRecord = exactRecord(edge, ["mechanismId", "outcome"], edgeLabel);
    return {
      mechanismId: requiredString(edgeRecord.mechanismId, `${edgeLabel}.mechanismId`),
      outcome: requiredOutcome(edgeRecord.outcome, `${edgeLabel}.outcome`),
    };
  });
  return {
    id,
    // evaluateAction owns the exact action-union validation so fixtures cannot
    // drift from the evaluator's public request grammar.
    requestedAction: record.requestedAction as MechanicsActionRequest,
    expected: { afterStateHash, trace },
  };
}

function parseFixtureCases(value: unknown): ParsedFixtureCase[] {
  if (!Array.isArray(value) || value.length === 0) fixtureInputError("fixtures must be a non-empty array");
  const fixtureIds = new Set<string>();
  return value.map((fixture, index) => {
    const parsed = parseFixtureCase(fixture, index);
    if (fixtureIds.has(parsed.id)) fixtureInputError(`duplicate fixture ID: ${parsed.id}`);
    fixtureIds.add(parsed.id);
    return parsed;
  });
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const leftRecord = left as Record<PropertyKey, unknown>;
  const rightRecord = right as Record<PropertyKey, unknown>;
  const leftKeys = Reflect.ownKeys(leftRecord);
  const rightKeys = Reflect.ownKeys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => rightKeys.includes(key) && deepEqual(leftRecord[key], rightRecord[key]));
}

function sameExpectedTrace(actual: readonly MechanicsReachabilityEdge[], expected: readonly EvaluateActionFixtureExpectedEdge[]): boolean {
  return actual.length === expected.length && actual.every((edge, index) => edge.mechanismId === expected[index]!.mechanismId && edge.outcome === expected[index]!.outcome);
}

function replayFinal(state: MechanicsState, stateHash: string): MechanicsWitness["final"] {
  if (state.terminalEndingId) return { kind: "ending", id: state.terminalEndingId, stateHash };
  if (state.terminalLoss) return { kind: "loss", id: state.terminalLoss.encounterId, stateHash };
  // The shared witness replayer's nonterminal final form asserts only that the
  // exact trace stops before a terminal state, which is what this runner needs.
  return { kind: "deadlock", id: stateHash, stateHash };
}

function verifyResult(ir: MechanicsIR, input: MechanicsAnalysisInput, fixture: ParsedFixtureCase, result: EvaluateActionResult, expectedBeforeStateHash: string): void {
  if (result.beforeStateHash !== expectedBeforeStateHash) fixtureMismatch(fixture.id, "beforeStateHash does not match the analysis entry state");
  if (result.afterStateHash !== mechanicsStateHash(result.finalState)) fixtureMismatch(fixture.id, "afterStateHash does not match finalState");
  if (result.trace.length === 0) fixtureMismatch(fixture.id, "action trace is empty");
  if (result.trace[0]!.beforeStateHash !== result.beforeStateHash) fixtureMismatch(fixture.id, "first trace edge does not start at beforeStateHash");
  for (const [index, edge] of result.trace.entries()) {
    const next = result.trace[index + 1];
    if (next && edge.afterStateHash !== next.beforeStateHash) fixtureMismatch(fixture.id, "trace edge hashes do not join");
  }
  if (result.trace[result.trace.length - 1]!.afterStateHash !== result.afterStateHash) fixtureMismatch(fixture.id, "last trace edge does not end at afterStateHash");
  if (!sameExpectedTrace(result.trace, fixture.expected.trace)) fixtureMismatch(fixture.id, "trace does not match the explicit expectation");
  if (result.afterStateHash !== fixture.expected.afterStateHash) fixtureMismatch(fixture.id, "afterStateHash does not match the explicit expectation");

  const witness: MechanicsWitness = {
    startSceneId: input.entrySceneId,
    steps: structuredClone([...result.trace]),
    final: replayFinal(result.finalState, result.afterStateHash),
  };
  const replayed = replayMechanicsWitness(ir, input, witness);
  if (mechanicsStateHash(replayed) !== result.afterStateHash || !deepEqual(replayed, result.finalState)) {
    fixtureMismatch(fixture.id, "trace is not replayable to finalState");
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return Object.freeze(value);
}

/**
 * Runs each explicit action fixture twice from the same analysis entry state.
 * The runner has no persistence or runtime dependencies: it validates hashes,
 * trace continuity, and shared-core witness replay entirely in memory.
 */
export function runEvaluateActionFixtures(
  mechanicsIR: MechanicsIR,
  analysisInput: MechanicsAnalysisInput,
  fixtures: NonEmptyReadonlyArray<EvaluateActionFixtureCase>,
): EvaluateActionFixtureReport {
  const parsedFixtures = parseFixtureCases(fixtures);
  const expectedBeforeStateHash = mechanicsStateHash(initialMechanicsState(analysisInput));
  const report: Record<string, EvaluateActionResult> = Object.create(null) as Record<string, EvaluateActionResult>;
  for (const fixture of parsedFixtures) {
    const first = evaluateAction({ mechanicsIR, analysisInput, requestedAction: fixture.requestedAction });
    const second = evaluateAction({ mechanicsIR, analysisInput, requestedAction: fixture.requestedAction });
    if (!deepEqual(first, second)) fixtureMismatch(fixture.id, "two evaluations are not deeply deterministic");
    verifyResult(mechanicsIR, analysisInput, fixture, first, expectedBeforeStateHash);
    verifyResult(mechanicsIR, analysisInput, fixture, second, expectedBeforeStateHash);
    report[fixture.id] = first;
  }
  return deepFreeze(report);
}
