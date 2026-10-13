import type { CompilerQuestion, CompilerQuestionResolution } from "../../compiler/compiler-question-queue";

/**
 * Test-only fixture adapter for closed legacy compiler flows.  Production
 * callers must supply the same explicit, source-exact partition through the
 * queue or proposal adapter; this merely keeps older fixtures equally
 * explicit after clue fact facets became publish-blocking.
 */
export function allShellClueFactFacetResolutions<T extends CompilerQuestionResolution>(
  questions: readonly CompilerQuestion[],
  answer: (question: CompilerQuestion, value: unknown) => T,
): T[] {
  return questions
    .filter((question) => question.kind === "clue_fact_facets")
    .map((question) => answer(question, {
      shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })),
      findings: [],
      sourceOnlyAtomIds: [],
    }));
}

export function clueFactFacetRevelations(bindings: ReadonlyArray<{
  clueId: string;
  shellAtoms: ReadonlyArray<{ quote: string }>;
  findings: ReadonlyArray<{ clueId: string; atoms: ReadonlyArray<{ quote: string }> }>;
}>): Map<string, string> {
  const revelations = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.shellAtoms.length || binding.findings.length) {
      revelations.set(binding.clueId, binding.shellAtoms.map((atom) => atom.quote).join("\n"));
    }
    for (const finding of binding.findings) revelations.set(finding.clueId, finding.atoms.map((atom) => atom.quote).join("\n"));
  }
  return revelations;
}
