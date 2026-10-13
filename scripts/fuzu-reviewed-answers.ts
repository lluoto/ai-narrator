import { join, resolve } from "path";
import { COMPILER_QUESTION_QUEUE_SCHEMA_VERSION, MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestionKind, type CompilerQuestionResolution, type ModuleCompileHints } from "../src/compiler/compiler-question-queue";

const ROOT = resolve(import.meta.dir, "..");
export const FUZU_REVIEWED_ANSWERS_FIXTURE_PATH = join(ROOT, "scripts", "fixtures", "fuzu-reviewed-answers.json");
export const FUZU_REVIEWED_ANSWERS_SCHEMA_VERSION = "fuzu-reviewed-answers-1.0";

const REVIEW_KIND_COUNTS = {
  connection_topology: 22,
  scene_role: 22,
  entry_scene: 1,
  core_clue: 3,
  discovery_method: 1,
  ending_rule: 1,
} as const;

type ReviewKind = keyof typeof REVIEW_KIND_COUNTS;

export interface FuzuReviewedAnswer {
  questionId: string;
  kind: ReviewKind;
  value: unknown;
  reason: string;
}

export interface FuzuReviewedAnswersFixture {
  schemaVersion: typeof FUZU_REVIEWED_ANSWERS_SCHEMA_VERSION;
  moduleId: string;
  documentHash: string;
  sourceGraphIdentity: string;
  preparedQueueHash: string;
  queueSchemaVersion: typeof COMPILER_QUESTION_QUEUE_SCHEMA_VERSION;
  answers: FuzuReviewedAnswer[];
}

export interface FuzuReviewedAnswersTarget {
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  preparedQueueHash: string;
  queueSchemaVersion: typeof COMPILER_QUESTION_QUEUE_SCHEMA_VERSION;
  questions: ReadonlyArray<{
    id: string;
    kind: CompilerQuestionKind;
    sourceStatementIds: readonly string[];
    evidenceRefs: readonly string[];
  }>;
}

function fail(message: string): never {
  throw new Error(`Fuzu reviewed answers fixture: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function only(input: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const key of Object.keys(input)) if (!fields.includes(key)) fail(`unknown ${label} field: ${key}`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail(`${label} requires human re-review`);
}

function reviewKind(value: unknown): ReviewKind {
  if (typeof value !== "string" || !Object.hasOwn(REVIEW_KIND_COUNTS, value)) fail("review answer kind is not allowed");
  return value as ReviewKind;
}

function parseFixture(input: unknown): FuzuReviewedAnswersFixture {
  const fixture = object(input, "fixture");
  only(fixture, ["schemaVersion", "moduleId", "documentHash", "sourceGraphIdentity", "preparedQueueHash", "queueSchemaVersion", "answers"], "fixture");
  if (fixture.schemaVersion !== FUZU_REVIEWED_ANSWERS_SCHEMA_VERSION) fail("fixture schema version requires human re-review");
  if (!Array.isArray(fixture.answers)) fail("fixture answers must be an array");
  return {
    schemaVersion: FUZU_REVIEWED_ANSWERS_SCHEMA_VERSION,
    moduleId: string(fixture.moduleId, "fixture module id"),
    documentHash: string(fixture.documentHash, "fixture document hash"),
    sourceGraphIdentity: string(fixture.sourceGraphIdentity, "fixture source graph identity"),
    preparedQueueHash: string(fixture.preparedQueueHash, "fixture prepared queue hash"),
    queueSchemaVersion: string(fixture.queueSchemaVersion, "fixture queue schema version") as typeof COMPILER_QUESTION_QUEUE_SCHEMA_VERSION,
    answers: fixture.answers.map((entry, index) => {
      const answer = object(entry, `review answer ${index}`);
      only(answer, ["questionId", "kind", "value", "reason"], "review answer");
      return {
        questionId: string(answer.questionId, `review answer ${index} question id`),
        kind: reviewKind(answer.kind),
        value: answer.value,
        reason: string(answer.reason, `review answer ${index} reason`),
      };
    }),
  };
}

function assertTargetIdentity(fixture: FuzuReviewedAnswersFixture, target: FuzuReviewedAnswersTarget): void {
  exactString(fixture.moduleId, target.moduleId, "module id");
  exactString(fixture.documentHash, target.documentHash ?? "", "document hash");
  exactString(fixture.sourceGraphIdentity, target.sourceGraphIdentity, "source graph identity");
  exactString(fixture.preparedQueueHash, target.preparedQueueHash, "prepared queue hash");
  exactString(fixture.queueSchemaVersion, target.queueSchemaVersion, "queue schema version");
}

function assertReviewShape(fixture: FuzuReviewedAnswersFixture, target: FuzuReviewedAnswersTarget): void {
  const expectedAnswerCount = Object.values(REVIEW_KIND_COUNTS).reduce((sum, count) => sum + count, 0);
  if (fixture.answers.length !== expectedAnswerCount) fail(`review answer count: expected ${expectedAnswerCount}, received ${fixture.answers.length}`);
  const ids = new Set<string>();
  const counts: Record<ReviewKind, number> = {
    connection_topology: 0,
    scene_role: 0,
    entry_scene: 0,
    core_clue: 0,
    discovery_method: 0,
    ending_rule: 0,
  };
  for (const answer of fixture.answers) {
    if (ids.has(answer.questionId)) fail(`duplicate review question id: ${answer.questionId}`);
    ids.add(answer.questionId);
    counts[answer.kind]++;
    const matches = target.questions.filter((question) => question.id === answer.questionId);
    if (matches.length !== 1) fail(`review question ${answer.questionId} must occur exactly once in the fresh queue`);
    if (matches[0]!.kind !== answer.kind) fail(`review kind must match the fresh question: ${answer.questionId}`);
  }
  for (const [kind, expected] of Object.entries(REVIEW_KIND_COUNTS) as Array<[ReviewKind, number]>) {
    if (counts[kind] !== expected) fail(`review ${kind} count: expected ${expected}, received ${counts[kind]}`);
  }
}

/**
 * Rebuild trusted human-answer provenance exclusively from the freshly
 * prepared queue. The fixture never carries sourceStatementIds, evidenceRefs,
 * authority, derivation, reviewer kind, or rights status.
 */
export function materializeFuzuReviewedHints(input: unknown, target: FuzuReviewedAnswersTarget): ModuleCompileHints {
  const fixture = parseFixture(input);
  assertTargetIdentity(fixture, target);
  assertReviewShape(fixture, target);
  const questions = new Map(target.questions.map((question) => [question.id, question]));
  const resolutions: CompilerQuestionResolution[] = fixture.answers.map((answer) => {
    const question = questions.get(answer.questionId);
    if (question === undefined) fail(`review question ${answer.questionId} must occur exactly once in the fresh queue`);
    return {
      questionId: question.id,
      kind: question.kind,
      value: structuredClone(answer.value),
      sourceStatementIds: [...question.sourceStatementIds],
      evidenceRefs: [...question.evidenceRefs],
      authority: "user_document",
      derivation: "explicit",
      reviewerKind: "human",
      rightsStatus: "user_provided",
      reason: answer.reason,
    };
  });
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: target.moduleId,
    documentHash: target.documentHash,
    sourceGraphIdentity: target.sourceGraphIdentity,
    resolutions,
  };
}

export async function readFuzuReviewedAnswersFixture(): Promise<unknown> {
  const file = Bun.file(FUZU_REVIEWED_ANSWERS_FIXTURE_PATH);
  if (!await file.exists()) fail("tracked compact fixture is missing; human re-review is required");
  try {
    return JSON.parse(await file.text()) as unknown;
  } catch {
    fail("tracked compact fixture is not valid JSON; human re-review is required");
  }
}
