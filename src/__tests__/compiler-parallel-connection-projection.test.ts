import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import {
  projectResolvedCompilerArtifact,
  validateCanonicalCompilerModuleProjection,
  type CompilerModuleDataProjection,
  type ModuleDataPresentationMetadata,
} from "../compiler/compiler-module-data-projection";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { sha256 } from "../ingest/document-ir";

const PAGES = [
  "Dock:\n▶Brass Key: The key opens the marked exit gate.\nExit:\nThe road leads away from the harbor.",
];

const CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function answer(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
  return {
    questionId: question.id,
    kind: question.kind,
    value,
    sourceStatementIds: [...question.sourceStatementIds],
    evidenceRefs: [...question.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "parallel connection projection fixture",
  };
}

function hints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const scene = (name: string) => draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name))!;
  const dock = scene("Dock");
  const exit = scene("Exit");
  const key = draft.clueCandidates.find((candidate) => candidate.displayName.startsWith("Brass"))!;
  const question = (kind: CompilerQuestion["kind"], subject?: string) => queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject))!;

  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((candidate) => candidate.kind === "clue_fact_facets").map((candidate) => answer(candidate, { shell: (candidate.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] })),
      ...queue.questions.filter((candidate) => candidate.kind === "scene_role").map((candidate) => answer(candidate, { role: "playable_scene" })),
      answer(question("entry_scene"), { sceneCandidateId: dock.id }),
      answer(question("connection_topology", dock.id), {
        connections: [
          { toSceneCandidateId: exit.id, connectionId: "dock_exit_open" },
          {
            toSceneCandidateId: exit.id,
            connectionId: "dock_exit_locked",
            availability: { kind: "connection_unlocked", connectionId: "dock_exit_locked" },
          },
        ],
      }),
      answer(question("connection_topology", exit.id), { connections: [] }),
      answer(question("core_clue", key.id), { clueCandidateId: key.id, required: false }),
      answer(question("discovery_method", key.id), {
        clueCandidateId: key.id,
        locationSceneCandidateId: dock.id,
        spec: {
          kind: "discovery_method",
          id: "find_brass_key",
          clueId: key.id,
          action: "search",
          target: "scene",
          targetId: dock.id,
          onSuccess: [
            { kind: "discover_clue", clueId: key.id },
            { kind: "unlock_connection", connectionId: "dock_exit_locked" },
          ],
        },
      }),
      answer(question("ending_rule"), {
        declarations: [
          {
            endingId: "parallel_clean_exit",
            spec: {
              kind: "ending_rule",
              id: "parallel_rule_clean",
              priority: 10,
              when: { kind: "all", predicates: [{ kind: "clue_found", clueId: key.id }, { kind: "scene_visited", sceneId: exit.id }] },
              effects: [{ kind: "end_game", endingId: "parallel_clean_exit" }],
            },
          },
          {
            endingId: "parallel_hasty_exit",
            spec: {
              kind: "ending_rule",
              id: "parallel_rule_hasty",
              priority: 20,
              when: {
                kind: "all",
                predicates: [
                  { kind: "scene_visited", sceneId: exit.id },
                  { kind: "not", predicate: { kind: "clue_found", clueId: key.id } },
                ],
              },
              effects: [{ kind: "end_game", endingId: "parallel_hasty_exit" }],
            },
          },
        ],
      }),
    ],
  };
}

async function fixture(): Promise<{ payload: ResolvedCompilerArtifactPayload; projection: CompilerModuleDataProjection; artifact: unknown }> {
  const prepared = await prepareCompiler({
    kind: "synthetic_pages",
    moduleId: "parallel-connection-projection",
    sourceDescriptor: "parallel-connection-projection",
    pages: PAGES,
  });
  if (prepared.status === "refused") throw new Error(prepared.message);
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints(prepared));
  if (resolved.status === "refused") throw new Error(resolved.message);
  const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
  const facetRevelations = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    if (binding.shellAtoms.length || binding.findings.length) facetRevelations.set(binding.clueId, binding.shellAtoms.map((atom) => atom.quote).join("\n") || payload.draft.clueCandidates.find((candidate) => candidate.id === binding.clueId)!.displayName);
    for (const finding of binding.findings) facetRevelations.set(finding.clueId, finding.atoms.map((atom) => atom.quote).join("\n"));
  }
  const metadata: ModuleDataPresentationMetadata = {
    module: {
      title: "Parallel connection fixture",
      version: "1",
      ruleset: "cosmic-horror",
      era: "test",
      summary: "parallel connection identity",
      playerCount: "1",
      expectedDuration: "short",
      triggerWarnings: [],
    },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, {
      findMethods: [],
      revelation: facetRevelations.get(id) ?? `revelation:${id}`,
      unlocks: [],
      importance: "bonus" as const,
    }])),
    endings: {
      parallel_clean_exit: { name: "Clean exit", description: "The key opens the marked gate.", conditions: ["key found"] },
      parallel_hasty_exit: { name: "Hasty exit", description: "The ordinary route remains open.", conditions: ["key absent"] },
    },
  };
  const projection = projectResolvedCompilerArtifact(payload, metadata);
  if (projection.status === "refused") throw new Error(projection.message);
  return { payload, projection, artifact: resolved.artifact };
}

function connectionMechanism(payload: ResolvedCompilerArtifactPayload, connectionId: string): string {
  return payload.mechanicsIR.connections.find((connection) => connection.connectionId === connectionId)!.id;
}

function session(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("bundle fixture has a non-JSON value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Recompute the catalog envelope checksum so loadBundle reaches projection revalidation. */
function rehashBundle(envelope: Record<string, unknown>): void {
  const { bundleHash: _bundleHash, ...unsigned } = envelope;
  envelope.bundleHash = sha256(canonicalJson(unsigned));
}

describe("compiled parallel connection projection", () => {
  it("preserves per-edge connection IDs through canonical projection and executable gates", async () => {
    const { payload, projection } = await fixture();
    const dock = projection.module.scenes.find((scene) => scene.name.startsWith("Dock"))!;
    const connections = dock.connections as Array<{ connectionId?: string; targetSceneId: string; condition: string }>;

    expect(connections.map((connection) => connection.connectionId).sort()).toEqual(["dock_exit_locked", "dock_exit_open"]);
    expect(validateCanonicalCompilerModuleProjection(payload, projection).status).toBe("projected");
    expect(projection.sourceMap.scenes[dock.id]!.connections.dock_exit_open!.fields.connectionId).toMatchObject({ kind: "artifact" });
    expect(projection.sourceMap.scenes[dock.id]!.connections.dock_exit_locked!.fields.connectionId).toMatchObject({ kind: "artifact" });

    const open = connectionMechanism(payload, "dock_exit_open");
    const locked = connectionMechanism(payload, "dock_exit_locked");
    const key = payload.mechanicsIR.discoveryMethods.find((method) => method.id === "find_brass_key")!.id;

    const ordinary = session("parallel-open");
    expect(ordinary.loadCompiledModule(payload, projection).status).toBe("loaded");
    expect((await ordinary.act(compiledMechanicsAction(locked))).error?.code).toBe("compiled_action_unavailable");
    expect((await ordinary.act(compiledMechanicsAction(open))).compiled?.terminalEnding?.id).toBe("parallel_hasty_exit");

    const unlocked = session("parallel-locked");
    expect(unlocked.loadCompiledModule(payload, projection).status).toBe("loaded");
    expect((await unlocked.act(compiledMechanicsAction(key))).error).toBeUndefined();
    expect((await unlocked.act(compiledMechanicsAction(locked))).compiled?.terminalEnding?.id).toBe("parallel_clean_exit");
  });

  it("rejects removed, duplicate, exchanged, and foreign compiled connection identities", async () => {
    const { payload, projection } = await fixture();
    const dock = projection.module.scenes.find((scene) => scene.name.startsWith("Dock"))!;
    const altered = (mutate: (connections: Array<Record<string, unknown>>) => void) => {
      const value = structuredClone(projection) as unknown as { module: { scenes: Array<{ id: string; connections: Array<Record<string, unknown>> }> } };
      mutate(value.module.scenes.find((scene) => scene.id === dock.id)!.connections);
      return validateCanonicalCompilerModuleProjection(payload, value);
    };

    expect(altered((connections) => { delete connections[0]!.connectionId; })).toMatchObject({ status: "refused" });
    expect(altered((connections) => { connections[1]!.connectionId = connections[0]!.connectionId; })).toMatchObject({ status: "refused" });
    expect(altered((connections) => { [connections[0]!.connectionId, connections[1]!.connectionId] = [connections[1]!.connectionId, connections[0]!.connectionId]; })).toMatchObject({ status: "refused" });
    expect(altered((connections) => { connections[0]!.connectionId = "foreign_connection"; })).toMatchObject({ status: "refused" });
  });

  it("revalidates a persisted parallel-edge projection before any durable session world write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parallel-projection-catalog-"));
    try {
      const { artifact, projection } = await fixture();
      const catalog = new CompilerArtifactCatalog({ root: dir });
      const saved = catalog.saveBundle(artifact, projection);
      expect(saved.status).toBe("ok");
      if (saved.status !== "ok") return;
      const loaded = catalog.loadBundle(saved.value.id);
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok") return;

      // Defense in depth: even a caller that bypasses catalog.loadBundle cannot
      // make a malformed projection reach a WorldStateManager mutation.
      const forgedForSession = structuredClone(loaded.value);
      const forgeDock = forgedForSession.projection.module.scenes.find((scene) => scene.name.startsWith("Dock"))!;
      delete forgeDock.connections[0]!.connectionId;
      const target = session("parallel-tampered-durable");
      const worldBefore = target.world.exportSnapshot();
      expect(target.loadDurableCompiledModule(forgedForSession).status).toBe("refused");
      expect(target.world.exportSnapshot()).toEqual(worldBefore);

      // This mutation has a valid envelope hash. The catalog must therefore
      // reject on the canonical compiled-projection check, not only checksum.
      const path = join(dir, "bundles", `${saved.value.id}.json`);
      const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
      const persistedDock = persisted.projection.module.scenes.find((scene: any) => String(scene.name).startsWith("Dock"));
      delete persistedDock.connections[0].connectionId;
      rehashBundle(persisted);
      writeFileSync(path, JSON.stringify(persisted));
      expect(new CompilerArtifactCatalog({ root: dir }).loadBundle(saved.value.id)).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts only mechanism codecs, so free-text or a raw connection ID cannot bypass parallel gates", async () => {
    const { payload, projection } = await fixture();
    const open = connectionMechanism(payload, "dock_exit_open");
    const locked = connectionMechanism(payload, "dock_exit_locked");
    const target = session("parallel-codec-only");
    expect(target.loadCompiledModule(payload, projection).status).toBe("loaded");
    const before = target.getCompiledMechanicsState()!;

    for (const input of ["Go to Exit", "move Exit", "use the marked exit gate"]) {
      expect((await target.act(input)).error?.code).toBe("compiled_action_required");
      expect(target.getCompiledMechanicsState()).toEqual(before);
    }
    expect((await target.act(compiledMechanicsAction("dock_exit_locked"))).error?.code).toBe("compiled_action_unavailable");
    expect(target.getCompiledMechanicsState()).toEqual(before);
    expect((await target.act(compiledMechanicsAction(locked))).error?.code).toBe("compiled_action_unavailable");
    expect(target.getCompiledMechanicsState()).toEqual(before);

    expect((await target.act(compiledMechanicsAction(open))).compiled?.terminalEnding?.id).toBe("parallel_hasty_exit");
  });
});
