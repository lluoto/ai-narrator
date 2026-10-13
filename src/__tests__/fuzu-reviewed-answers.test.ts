import { describe, expect, it } from "bun:test";
import { statSync } from "fs";
import { FUZU_REVIEWED_ANSWERS_FIXTURE_PATH, materializeFuzuReviewedHints, readFuzuReviewedAnswersFixture, type FuzuReviewedAnswersFixture, type FuzuReviewedAnswersTarget } from "../../scripts/fuzu-reviewed-answers";

const DOCUMENT_HASH = "a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5";
const TARGET: FuzuReviewedAnswersTarget = {
  moduleId: "fuzu",
  documentHash: DOCUMENT_HASH,
  sourceGraphIdentity: "source-graph-current",
  preparedQueueHash: "queue-current",
  queueSchemaVersion: "3.4.0",
  questions: [
    ...Array.from({ length: 22 }, (_, index) => ({ id: `topology-${index}`, kind: "connection_topology" as const, sourceStatementIds: [`statement-topology-${index}`], evidenceRefs: [`evidence-topology-${index}`] })),
    ...Array.from({ length: 22 }, (_, index) => ({ id: `role-${index}`, kind: "scene_role" as const, sourceStatementIds: [`statement-role-${index}`], evidenceRefs: [`evidence-role-${index}`] })),
    { id: "entry", kind: "entry_scene" as const, sourceStatementIds: ["statement-entry"], evidenceRefs: ["evidence-entry"] },
    ...Array.from({ length: 3 }, (_, index) => ({ id: `core-${index}`, kind: "core_clue" as const, sourceStatementIds: [`statement-core-${index}`], evidenceRefs: [`evidence-core-${index}`] })),
    { id: "discovery", kind: "discovery_method" as const, sourceStatementIds: ["statement-discovery"], evidenceRefs: ["evidence-discovery"] },
    { id: "ending", kind: "ending_rule" as const, sourceStatementIds: ["statement-ending"], evidenceRefs: ["evidence-ending"] },
  ],
};

function fixture(): FuzuReviewedAnswersFixture {
  return {
    schemaVersion: "fuzu-reviewed-answers-1.0",
    moduleId: TARGET.moduleId,
    documentHash: DOCUMENT_HASH,
    sourceGraphIdentity: TARGET.sourceGraphIdentity,
    preparedQueueHash: TARGET.preparedQueueHash,
    queueSchemaVersion: TARGET.queueSchemaVersion,
    answers: TARGET.questions.map((question) => ({ questionId: question.id, kind: question.kind as FuzuReviewedAnswersFixture["answers"][number]["kind"], value: { reviewed: question.id }, reason: "human benchmark judgment" })),
  };
}

describe("Fuzu compact reviewed-answer fixture", () => {
  it("reads the tracked compact fixture, not an ignored analysis artifact", async () => {
    const tracked = await readFuzuReviewedAnswersFixture() as FuzuReviewedAnswersFixture;
    expect(statSync(FUZU_REVIEWED_ANSWERS_FIXTURE_PATH).size).toBeLessThan(20_000);
    expect(tracked.answers).toHaveLength(50);
    expect(Object.fromEntries(["connection_topology", "scene_role", "entry_scene", "core_clue", "discovery_method", "ending_rule"].map((kind) => [kind, tracked.answers.filter((answer) => answer.kind === kind).length]))).toEqual({ connection_topology: 22, scene_role: 22, entry_scene: 1, core_clue: 3, discovery_method: 1, ending_rule: 1 });
    expect(JSON.stringify(tracked)).not.toContain("sourceStatementIds");
    expect(JSON.stringify(tracked)).not.toContain("evidenceRefs");
    expect(JSON.stringify(tracked)).not.toContain("reviewerKind");
    expect(JSON.stringify(tracked)).not.toContain("rightsStatus");
    expect(JSON.stringify(tracked)).not.toContain("\"authority\"");
    expect(JSON.stringify(tracked)).not.toContain("\"audit\"");
  });

  it("makes the tracked compact fixture authoritative and rebuilds source evidence from the fresh queue", () => {
    const hints = materializeFuzuReviewedHints(fixture(), TARGET);
    expect(hints.resolutions).toHaveLength(50);
    expect(hints.resolutions[0]).toMatchObject({ authority: "user_document", derivation: "explicit", reviewerKind: "human", rightsStatus: "user_provided" });
    expect(hints.resolutions[0]?.sourceStatementIds).toEqual(["statement-topology-0"]);
    expect(hints.resolutions[0]?.evidenceRefs).toEqual(["evidence-topology-0"]);
  });

  it("fails closed for identity drift, duplicate/unknown IDs, kind drift, and unknown fields", () => {
    expect(() => materializeFuzuReviewedHints({ ...fixture(), preparedQueueHash: "tampered" }, TARGET)).toThrow("prepared queue hash requires human re-review");
    expect(() => materializeFuzuReviewedHints({ ...fixture(), answers: [...fixture().answers, { ...fixture().answers[0]! }] }, TARGET)).toThrow("review answer count");
    expect(() => materializeFuzuReviewedHints({ ...fixture(), answers: fixture().answers.map((answer, index) => index === 0 ? { ...answer, questionId: "unknown" } : answer) }, TARGET)).toThrow("must occur exactly once in the fresh queue");
    expect(() => materializeFuzuReviewedHints({ ...fixture(), answers: fixture().answers.map((answer, index) => index === 0 ? { ...answer, kind: "scene_role" } : answer) }, TARGET)).toThrow("review kind must match the fresh question");
    expect(() => materializeFuzuReviewedHints({ ...fixture(), extra: true }, TARGET)).toThrow("unknown fixture field");
    expect(() => materializeFuzuReviewedHints({ ...fixture(), answers: fixture().answers.map((answer, index) => index === 0 ? { ...answer, authority: "approved_policy" } : answer) }, TARGET)).toThrow("unknown review answer field");
    expect(() => materializeFuzuReviewedHints({ ...fixture(), answers: fixture().answers.map((answer, index) => index === 0 ? { ...answer, sourceStatementIds: ["forged"] } : answer) }, TARGET)).toThrow("unknown review answer field");
  });
});
