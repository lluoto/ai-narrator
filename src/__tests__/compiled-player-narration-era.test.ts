import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCompiledSessionAccessBinding } from "../api/compiled-module-http";
import { GameSession, prepareCompiledDurableNarration, validateCompiledDurableNarrationText } from "../api/game-session";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import {
  buildTrustedPresentationReviewCandidatePage,
  projectTrustedResolvedCompilerArtifact,
  TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE,
} from "../compiler/compiler-module-data-projection";
import { narrateCompiledPlayerCandidate } from "../llm/compiled-player-narration";
import type { LLMLike } from "../llm/client";
import { compiledModuleHttpFixture, PAGES, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
function saveTrustedFixtureBundleWithEra(catalog: CompilerArtifactCatalog, fixture: Awaited<ReturnType<typeof compiledModuleHttpFixture>>, era: string) {
  const prepared = catalog.savePrepared(fixture.prepared.artifact);
  if (prepared.status !== "ok") throw new Error(prepared.message);
  const payload = fixture.resolved.artifact.payload as any;
  const bindings = exactReviewBindings(payload);
  let eraBinding: any | undefined;
  for (let offset = 0; eraBinding === undefined; offset += TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) {
    const page = buildTrustedPresentationReviewCandidatePage(payload, "module.era", offset);
    if (page.status === "refused") throw new Error(page.message);
    eraBinding = page.page.candidates.find((candidate) => candidate.exactText === era)?.binding;
    if (!page.page.hasMore) break;
  }
  if (!eraBinding) throw new Error("source document did not expose the requested exact era candidate");
  const review = catalog.saveTrustedPresentationReview(
    prepared.value.id,
    fixture.prepared.artifact,
    fixture.resolved.artifact,
    "operator:narration-era",
    bindings.map((binding: any) => binding.fieldPath === "module.era" ? eraBinding : binding),
  );
  if (review.status !== "ok") throw new Error(review.message);
  const persisted = catalog.loadTrustedPresentationReview(review.value.id);
  if (persisted.status !== "ok") throw new Error(persisted.message);
  const projection = projectTrustedResolvedCompilerArtifact(payload, persisted.value.review);
  if (projection.status === "refused") throw new Error(projection.message);
  const saved = catalog.saveBundle(fixture.resolved.artifact, projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  return saved.value;
}

async function reviewedCandidate(root: string, era?: string) {
  // An appended unheaded source statement is scoped by the existing final
  // scene heading, so it does not add an executable scene/mechanic. Review
  // still has to select its exact text before it can populate module.era.
  const fixture = era === undefined
    ? await compiledModuleHttpFixture("narration-era-unknown")
    : await compiledModuleHttpFixture(`narration-era-${era}`, [...PAGES, era]);
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = era === undefined ? saveTrustedFixtureBundle(catalog, fixture) : saveTrustedFixtureBundleWithEra(catalog, fixture, era);
  const bundle = catalog.loadBundle(saved.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const host = createCompiledDurableTestHost();
  const session = new GameSession(`narration-era-${era ?? "unknown"}`, "cosmic-horror", CONFIG, "investigator", "Ada", undefined,
    { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
  const loaded = session.loadDurableCompiledModule(bundle.value, createCompiledSessionAccessBinding(
    { id: `keeper:narration-era-${era ?? "unknown"}`, role: "keeper" }, { id: `player:narration-era-${era ?? "unknown"}`, role: "player" },
  ));
  if (loaded.status === "refused") throw new Error(loaded.message);
  const snapshot = host.snapshot(session);
  host.acknowledge(session, snapshot);
  const action = session.getCompiledAvailableActions()[0];
  if (!action) throw new Error("fixture must offer a compiled action");
  const prepared = prepareCompiledDurableNarration(session, host.capability, action.command, `era-${era ?? "unknown"}`, 0);
  if (prepared.status !== "prepared") throw new Error("candidate was not prepared");
  return { session, candidate: prepared.candidate, host };
}

describe("compiled player narration era frame", () => {
  it("uses an admitted frame era rather than a fixed 1920s instruction, and omits unknown eras", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-era-"));
    const sessions: GameSession[] = [];
    try {
      const unknown = await reviewedCandidate(join(root, "unknown"));
      sessions.push(unknown.session);
      // This trusted review has no structured year, so the host must not
      // supply a default chronology to the adapter.
      expect(unknown.candidate.frame.before.era).toBeUndefined();
      expect(unknown.candidate.frame.after.era).toBeUndefined();
      // The compiled-only unknown-era policy skips year-ranged technology
      // rules, but this does not relax no-year source/privacy rules (covered
      // through the real HTTP path elsewhere).
      expect(validateCompiledDurableNarrationText(
        unknown.session,
        unknown.host.capability,
        unknown.candidate,
        { schemaVersion: "1.0.0", text: "电脑发出微弱的嗡鸣。" },
      )).toBe(true);
      const captures: string[] = [];
      for (const era of ["1893", "1980"]) {
        const built = await reviewedCandidate(join(root, era), era);
        sessions.push(built.session);
        const candidate = built.candidate;
        expect(candidate.frame.before.era).toBe(era);
        expect(candidate.frame.after.era).toBe(era);
        // This text has no source-exact technology term in the fixture.  The
        // host must therefore consume the reviewed year: 1893 blocks it,
        // while 1980 does not.  Merely serializing era into the prompt is not
        // enough evidence of this receipt-admission behavior.
        expect(validateCompiledDurableNarrationText(
          built.session,
          built.host.capability,
          candidate,
          { schemaVersion: "1.0.0", text: "电脑发出微弱的嗡鸣。" },
        )).toBe(era === "1980");
        const llm: LLMLike = {
          async chat(messages) {
            captures.push(JSON.stringify(messages));
            return '{"text":"调查员停在已审阅的门槛前。"}';
          },
        };
        await expect(narrateCompiledPlayerCandidate({ candidate, llm })).resolves.toMatchObject({ status: "accepted" });
      }
      const prompts = captures.map((captured) => JSON.parse(captured) as Array<{ role: string; content: string }>);
      const body = (prompt: Array<{ role: string; content: string }>) => JSON.parse(prompt.find((message) => message.role === "user")!.content) as { before: { era?: string }; after: { era?: string } };
      expect(body(prompts[0]!).before.era).toBe("1893");
      expect(body(prompts[0]!).after.era).toBe("1893");
      expect(body(prompts[1]!).before.era).toBe("1980");
      expect(body(prompts[1]!).after.era).toBe("1980");
      for (const prompt of prompts) {
        const system = prompt.find((message) => message.role === "system")!.content;
        expect(system).toContain("natural Chinese");
        expect(system).toContain("reviewed era only");
        expect(system).not.toContain("1920s");
      }
    } finally {
      for (const session of sessions) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
