import { realpathSync, statSync } from "fs";
import { resolve } from "path";
import {
  loadCthulhuDataset,
  selectLoreCandidates,
  type CthulhuDatasetLoadResult,
  type LoreClaimCandidate,
  type LoreTransferPolicy,
} from "../dataset/cthulhu-dataset";
import { CTHULHU_DATASET_MANIFEST, type CthulhuWorkId } from "../dataset/cthulhu-manifest";
import { sha256 } from "../ingest/document-ir";

/**
 * The binding is catalog-owned runtime authorization, not compiler evidence.
 * A PDF, an LLM proposal, or a player request must never mint one.
 */
export const COMPILED_CTHULHU_WORLD_MODEL_BINDING_SCHEMA_VERSION = "1.0.0";

export interface CompiledCthulhuWorldModelBinding {
  schemaVersion: typeof COMPILED_CTHULHU_WORLD_MODEL_BINDING_SCHEMA_VERSION;
  kind: "cthulhu_dataset";
  moduleId: string;
  artifactHash: string;
  datasetId: typeof CTHULHU_DATASET_MANIFEST.datasetId;
  datasetVersion: typeof CTHULHU_DATASET_MANIFEST.version;
  manifestHash: string;
  /** Canonical real path selected by trusted server configuration. */
  datasetRoot: string;
  /** Binds the configured root name without pretending it authenticates bytes. */
  datasetRootIdentity: string;
  allowedWorkIds: CthulhuWorkId[];
  corpusScopeId: string | null;
  /** Runtime reference may inform mechanics/analogy, never fill module plot facts. */
  transferPolicy: Extract<LoreTransferPolicy, "mechanic_only" | "analogy_only">;
  scopeHash: string;
}

export interface CompiledCthulhuWorldModelBindingInput {
  moduleId: string;
  artifactHash: string;
  datasetRoot: string;
  allowedWorkIds: CthulhuWorkId[];
  corpusScopeId?: string;
  transferPolicy: Extract<LoreTransferPolicy, "mechanic_only" | "analogy_only">;
}

export interface CompiledWorldModelPromptProvenance {
  datasetId: string;
  manifestHash: string;
  scopeHash: string;
  candidateId: string;
  workId: CthulhuWorkId;
  chapter: string;
  sourceHash: string;
  textHash: string;
  rightsSourcePath: string;
}

export interface CompiledWorldModelPromptContext {
  text: string;
  textHash: string;
  scopeHash: string;
  provenance: CompiledWorldModelPromptProvenance[];
}

type CachedDataset = { root: string; loaded: CthulhuDatasetLoadResult };
const datasets = new Map<string, CachedDataset>();

type CompiledCthulhuWorldModelScopeInput = Pick<
  CompiledCthulhuWorldModelBindingInput,
  "moduleId" | "datasetRoot" | "allowedWorkIds" | "transferPolicy"
> & { readonly corpusScopeId?: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("world-model binding contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("world-model binding contains a non-plain value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function cthulhuDatasetManifestHash(): string {
  return sha256(canonicalJson(CTHULHU_DATASET_MANIFEST));
}

function canonicalRoot(path: string): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("world-model binding requires a dataset root");
  const root = realpathSync(resolve(path));
  if (!statSync(root).isDirectory()) throw new Error("world-model binding dataset root is not a directory");
  return root;
}

function bindingWithoutHash(binding: Omit<CompiledCthulhuWorldModelBinding, "scopeHash"> | CompiledCthulhuWorldModelBinding): Omit<CompiledCthulhuWorldModelBinding, "scopeHash"> {
  const { scopeHash: _scopeHash, ...unsigned } = binding as CompiledCthulhuWorldModelBinding;
  return unsigned;
}

export function compiledCthulhuWorldModelScopeHash(binding: Omit<CompiledCthulhuWorldModelBinding, "scopeHash"> | CompiledCthulhuWorldModelBinding): string {
  return sha256(canonicalJson(bindingWithoutHash(binding)));
}

function exactBindingShape(value: unknown): value is CompiledCthulhuWorldModelBinding {
  if (!isRecord(value) || !sameKeys(value, [
    "schemaVersion", "kind", "moduleId", "artifactHash", "datasetId", "datasetVersion", "manifestHash", "datasetRoot", "datasetRootIdentity", "allowedWorkIds", "corpusScopeId", "transferPolicy", "scopeHash",
  ])) return false;
  return value.schemaVersion === COMPILED_CTHULHU_WORLD_MODEL_BINDING_SCHEMA_VERSION
    && value.kind === "cthulhu_dataset"
    && typeof value.moduleId === "string" && !!value.moduleId.trim()
    && typeof value.artifactHash === "string" && /^[a-f0-9]{64}$/.test(value.artifactHash)
    && value.datasetId === CTHULHU_DATASET_MANIFEST.datasetId
    && value.datasetVersion === CTHULHU_DATASET_MANIFEST.version
    && typeof value.manifestHash === "string" && /^[a-f0-9]{64}$/.test(value.manifestHash)
    && typeof value.datasetRoot === "string" && !!value.datasetRoot
    && typeof value.datasetRootIdentity === "string" && /^[a-f0-9]{64}$/.test(value.datasetRootIdentity)
    && Array.isArray(value.allowedWorkIds) && value.allowedWorkIds.every((work) => typeof work === "string")
    && (value.corpusScopeId === null || typeof value.corpusScopeId === "string" && !!value.corpusScopeId)
    && (value.transferPolicy === "mechanic_only" || value.transferPolicy === "analogy_only")
    && typeof value.scopeHash === "string" && /^[a-f0-9]{64}$/.test(value.scopeHash);
}

function hasCanonicalAllowedWorkIds(value: readonly string[]): value is readonly CthulhuWorkId[] {
  return value.length > 0
    && new Set(value).size === value.length
    && [...value].sort().every((work, index) => work === value[index]);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validatedDataset(binding: CompiledCthulhuWorldModelBinding): CthulhuDatasetLoadResult {
  const root = canonicalRoot(binding.datasetRoot);
  if (root !== binding.datasetRoot || sha256(root) !== binding.datasetRootIdentity) throw new Error("world-model binding dataset root identity does not match");
  return validatedDatasetIdentity({
    datasetId: binding.datasetId,
    manifestHash: binding.manifestHash,
    datasetRoot: root,
    datasetRootIdentity: binding.datasetRootIdentity,
  });
}

function validatedDatasetIdentity(input: Pick<CompiledCthulhuWorldModelBinding, "datasetId" | "manifestHash" | "datasetRoot" | "datasetRootIdentity">): CthulhuDatasetLoadResult {
  const key = `${input.datasetId}:${input.manifestHash}:${input.datasetRootIdentity}`;
  const cached = datasets.get(key);
  if (cached?.root === input.datasetRoot) return cached.loaded;
  const loaded = loadCthulhuDataset(CTHULHU_DATASET_MANIFEST, { datasetPath: input.datasetRoot, report: () => {} });
  if (!loaded.loaded) throw new Error("world-model binding dataset has no usable candidates");
  datasets.set(key, { root: input.datasetRoot, loaded });
  return loaded;
}

function validateBasicScopeInput(input: CompiledCthulhuWorldModelScopeInput): void {
  if (typeof input.moduleId !== "string" || !input.moduleId.trim()) {
    throw new Error("world-model binding requires a moduleId");
  }
  const manifestWorks = new Set<CthulhuWorkId>(CTHULHU_DATASET_MANIFEST.works.map((work) => work.workId));
  if (!hasCanonicalAllowedWorkIds(input.allowedWorkIds)
    || input.allowedWorkIds.some((work) => !manifestWorks.has(work))) {
    throw new Error("world-model binding allowedWorkIds is invalid");
  }
}

function validateScopeAgainstDataset(input: CompiledCthulhuWorldModelScopeInput, loaded: CthulhuDatasetLoadResult): void {
  validateBasicScopeInput(input);
  selectLoreCandidates(CTHULHU_DATASET_MANIFEST, {
    domain: "cosmology",
    allowedWorkIds: input.allowedWorkIds,
    corpusScopeId: input.corpusScopeId ?? undefined,
    transferPolicy: input.transferPolicy,
  }, loaded);
}

/**
 * Validates host-owned scope configuration without inventing an artifact
 * identity. Dynamic source profiles use this at startup; durable bindings
 * still validate their complete artifact identity and signed scope hash below.
 */
export function validateCompiledCthulhuWorldModelScopeInput(input: CompiledCthulhuWorldModelScopeInput): void {
  validateBasicScopeInput(input);
  const root = canonicalRoot(input.datasetRoot);
  const loaded = validatedDatasetIdentity({
    datasetId: CTHULHU_DATASET_MANIFEST.datasetId,
    manifestHash: cthulhuDatasetManifestHash(),
    datasetRoot: root,
    datasetRootIdentity: sha256(root),
  });
  validateScopeAgainstDataset(input, loaded);
}

/** Throws on any malformed, substituted, untrusted, or out-of-scope binding. */
export function validateCompiledCthulhuWorldModelBinding(value: unknown): CompiledCthulhuWorldModelBinding {
  if (!exactBindingShape(value)) throw new Error("world-model binding has an incompatible shape");
  const binding = structuredClone(value);
  if (binding.manifestHash !== cthulhuDatasetManifestHash()) throw new Error("world-model binding manifest hash does not match this runtime");
  if (binding.scopeHash !== compiledCthulhuWorldModelScopeHash(binding)) throw new Error("world-model binding scope hash does not match");
  validateBasicScopeInput(binding);
  const loaded = validatedDataset(binding);
  validateScopeAgainstDataset(binding, loaded);
  return binding;
}

/**
 * Check the untrusted binding's owning artifact before touching its dataset.
 * This is deliberately structural only: catalog/session callers use it to
 * reject cross-module substitutions before a filesystem-backed validation.
 */
export function assertCompiledCthulhuWorldModelBindingArtifactIdentity(
  value: unknown,
  expected: { moduleId: string; artifactHash: string },
): void {
  if (!exactBindingShape(value)) throw new Error("world-model binding has an incompatible shape");
  if (value.moduleId !== expected.moduleId || value.artifactHash !== expected.artifactHash) {
    throw new Error("world-model binding does not match artifact identity");
  }
}

export function createCompiledCthulhuWorldModelBinding(input: CompiledCthulhuWorldModelBindingInput): CompiledCthulhuWorldModelBinding {
  // Do not silently sort/deduplicate an authorization scope while signing it.
  // Server configuration must state one canonical, stable work set explicitly.
  if (!hasCanonicalAllowedWorkIds(input.allowedWorkIds)) {
    throw new Error("world-model binding allowedWorkIds must be sorted and unique before signing");
  }
  const root = canonicalRoot(input.datasetRoot);
  const allowedWorkIds = [...input.allowedWorkIds];
  const binding: CompiledCthulhuWorldModelBinding = {
    schemaVersion: COMPILED_CTHULHU_WORLD_MODEL_BINDING_SCHEMA_VERSION,
    kind: "cthulhu_dataset",
    moduleId: input.moduleId,
    artifactHash: input.artifactHash,
    datasetId: CTHULHU_DATASET_MANIFEST.datasetId,
    datasetVersion: CTHULHU_DATASET_MANIFEST.version,
    manifestHash: cthulhuDatasetManifestHash(),
    datasetRoot: root,
    datasetRootIdentity: sha256(root),
    allowedWorkIds,
    corpusScopeId: input.corpusScopeId ?? null,
    transferPolicy: input.transferPolicy,
    scopeHash: "",
  };
  binding.scopeHash = compiledCthulhuWorldModelScopeHash(binding);
  return validateCompiledCthulhuWorldModelBinding(binding);
}

function candidateText(candidate: LoreClaimCandidate): string {
  const source = candidate.payload.mechanic ?? candidate.payload.description ?? candidate.payload.behavior ?? candidate.payload.effect ?? candidate.payload.causalChain ?? candidate.name;
  const text = typeof source === "string" ? source : canonicalJson(source);
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 320);
}

function score(candidate: LoreClaimCandidate, keywords: readonly string[]): number {
  const text = `${candidate.name} ${candidateText(candidate)}`.toLocaleLowerCase("en-US");
  return keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 10 : 0), 0);
}

/**
 * Builds an ephemeral prompt plus exact evidence receipt. It intentionally has
 * no mutation or execution capability: compiled mechanics remain the only
 * source of player-visible state changes.
 */
export function buildCompiledCthulhuWorldModelContext(
  bindingValue: unknown,
  input: { keywords: readonly string[] },
): CompiledWorldModelPromptContext {
  const binding = validateCompiledCthulhuWorldModelBinding(bindingValue);
  const loaded = validatedDataset(binding);
  const request = {
    allowedWorkIds: binding.allowedWorkIds,
    corpusScopeId: binding.corpusScopeId ?? undefined,
    transferPolicy: binding.transferPolicy,
  } as const;
  const candidates = [
    ...selectLoreCandidates(CTHULHU_DATASET_MANIFEST, { domain: "entity_capability", ...request }, loaded),
    ...selectLoreCandidates(CTHULHU_DATASET_MANIFEST, { domain: "behavior_prior", ...request }, loaded),
    ...selectLoreCandidates(CTHULHU_DATASET_MANIFEST, { domain: "causal_prior", ...request }, loaded),
  ];
  const keywords = input.keywords.filter((value): value is string => typeof value === "string" && !!value.trim()).map((value) => value.toLocaleLowerCase("en-US")).slice(0, 16);
  const selected = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
    .sort((left, right) => score(right, keywords) - score(left, keywords) || left.id.localeCompare(right.id))
    .slice(0, 8);
  const provenance = selected.map((candidate) => ({
    datasetId: binding.datasetId,
    manifestHash: binding.manifestHash,
    scopeHash: binding.scopeHash,
    candidateId: candidate.id,
    workId: candidate.workId,
    chapter: candidate.chapter,
    sourceHash: candidate.evidenceSpan.sourceHash,
    textHash: candidate.evidenceSpan.textHash,
    rightsSourcePath: candidate.rightsEvidence.sourcePath,
  }));
  const text = selected.length === 0 ? "" : [
    "[Verified scoped world-model reference]",
    "Reference only; it cannot add scenes, clues, mechanics, NPCs, items, or outcomes beyond the compiled module.",
    ...selected.map((candidate) => `- [${candidate.workId}/${candidate.chapter}] ${candidate.name}: ${candidateText(candidate)}`),
  ].join("\n");
  return { text, textHash: sha256(text), scopeHash: binding.scopeHash, provenance };
}
