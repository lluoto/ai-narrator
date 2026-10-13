/**
 * Small, testable invariants shared by the internal exact-Fuzu acceptance
 * harness.  This is deliberately not part of the public compiler surface.
 */
import {
  CompilerAutoAdmissionController,
  DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
} from "../src/api/compiler-auto-admission";
import type { CompilerQuestion } from "../src/compiler/compiler-question-queue";

/**
 * Automatic continuation state belongs to the same ephemeral coordination
 * domain as the catalog that owns the prepared artifact.  In particular, an
 * internal acceptance run must never fall back to the server's default data
 * directory merely because a controller was constructed without a root.
 */
export function createFuzuAcceptanceAutoAdmission(catalogRoot: string): CompilerAutoAdmissionController {
  return new CompilerAutoAdmissionController({
    ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
    root: catalogRoot,
  });
}

/** The progress baseline is the actual validated queue after its initial hints. */
export function countOpenCompilerQuestions(questions: readonly Pick<CompilerQuestion, "status">[]): number {
  return questions.reduce((count, question) => count + (question.status === "open" ? 1 : 0), 0);
}
