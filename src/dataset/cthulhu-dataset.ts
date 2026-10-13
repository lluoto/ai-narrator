import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import {
  CTHULHU_DATASET_MANIFEST,
  type CthulhuDatasetManifest,
  type CthulhuWorkId,
  type CthulhuWorkManifest,
} from "./cthulhu-manifest";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type LoreClaimDomain =
  | "cosmology"
  | "entity_capability"
  | "behavior_prior"
  | "causal_prior"
  | "strategy";

export type LoreTransferPolicy = "plot_fact" | "mechanic_only" | "analogy_only";

export interface LoreEvidenceSpan {
  sourceHash: string;
  chapter: string;
  chunkPath: string;
  startLine: number;
  endLine: number;
  textHash: string;
}

export interface LoreRightsEvidence {
  sourcePath: string;
  statementLocation: string;
  statement: string;
  rightsStatus: "unknown";
}

export interface LoreClaimPayload {
  mechanic?: JsonValue;
  description?: JsonValue;
  properties?: JsonObject | JsonValue[];
  causalChain?: JsonValue;
  effect?: JsonValue;
  trigger?: JsonValue;
  domains?: JsonValue;
  quoteAttribution?: JsonValue;
  use?: JsonValue;
  purpose?: JsonValue;
  usage?: JsonValue;
  origin?: JsonValue;
  status?: JsonValue;
  location?: JsonValue;
  weakness?: JsonValue;
  useCase?: JsonValue;
  arrival?: JsonValue;
  awakeningCondition?: JsonValue;
  behavior?: JsonValue;
  condition?: JsonValue;
  form?: JsonValue;
  nature?: JsonValue;
  role?: JsonValue;
  progression?: JsonValue;
  extractionFlags: { gameRule: boolean };
  extras: JsonObject;
}

export interface LoreClaimCandidate {
  id: string;
  type: string;
  name: string;
  workId: CthulhuWorkId;
  chapter: string;
  evidenceSpan: LoreEvidenceSpan;
  payload: LoreClaimPayload;
  authority: "declared_canon";
  derivation: "inferred";
  status: "candidate";
  confidence: number;
  extractionModel?: string;
  scope: {
    workId: CthulhuWorkId;
    chapter: string;
    era?: string;
    evidencePrecision: "chunk";
    transferPolicy: LoreTransferPolicy | "unassigned";
    canFillPlotFacts: boolean;
  };
  rightsEvidence: LoreRightsEvidence;
  warnings: string[];
}

export interface LoreQueryRequest {
  domain: LoreClaimDomain;
  allowedWorkIds: CthulhuWorkId[];
  entityNames?: string[];
  claimTypes?: string[];
  chapter?: string;
  era?: string;
  transferPolicy: LoreTransferPolicy;
  corpusScopeId?: string;
}

export interface RejectedLoreRecord {
  artifactPath: string;
  line: number;
  error: string;
}

export interface IgnoredArtifactResult {
  path: string;
  status: "ignored_empty_legacy_artifact";
  loaded: false;
}

export interface AnalysisArtifactResult {
  path: string;
  status: "migration_analysis_only";
  loaded: false;
}

export interface CthulhuDatasetLoadResult {
  loaded: boolean;
  resolvedPath: string;
  evidencePrecision: "chunk";
  candidates: LoreClaimCandidate[];
  rejectedRecords: RejectedLoreRecord[];
  chapterInventory: ChapterInventoryEntry[];
  loadedArtifacts: string[];
  analysisArtifacts: AnalysisArtifactResult[];
  ignoredArtifacts: IgnoredArtifactResult[];
}

export interface ChapterMetadata {
  chapter: number;
  novel: CthulhuWorkId;
  start_line: number;
  end_line: number;
  line_count: number;
  first_line: string;
  file: string;
  chars: number;
}

export interface ChapterInventoryEntry {
  workId: CthulhuWorkId;
  chapter: string;
  chunkPath: string;
  metadataPath: string;
  metadata: ChapterMetadata;
  textHash: string;
  metadataHash: string;
}

export interface RawArtifactRecord {
  artifactPath: string;
  line: number;
  value: JsonObject;
}

export interface DatasetLoadOptions {
  datasetPath?: string;
  report?: (message: string) => void;
}

const DEFAULT_DATASET_PATH = "../世界模型/datasets/cthulhu";

const DOMAIN_TYPES: Record<LoreClaimDomain, ReadonlySet<string>> = {
  cosmology: new Set(["cosmology", "deity", "institution", "faction_relation"]),
  entity_capability: new Set(["power_system", "deity", "game_mechanic", "resource"]),
  behavior_prior: new Set(["behavior", "deity", "faction_relation", "institution"]),
  causal_prior: new Set(["causal", "cosmology", "power_system"]),
  strategy: new Set(["strategy", "crafting", "resource", "game_mechanic", "behavior"]),
};

const MECHANIC_TYPES = new Set(["power_system", "game_mechanic", "resource", "crafting", "strategy", "causal"]);

const KNOWN_PAYLOAD_FIELDS: Array<[string, (payload: LoreClaimPayload, value: JsonValue) => void]> = [
  ["mechanic", (payload, value) => { payload.mechanic = structuredClone(value); }],
  ["description", (payload, value) => { payload.description = structuredClone(value); }],
  ["causal_chain", (payload, value) => { payload.causalChain = structuredClone(value); }],
  ["effect", (payload, value) => { payload.effect = structuredClone(value); }],
  ["trigger", (payload, value) => { payload.trigger = structuredClone(value); }],
  ["domains", (payload, value) => { payload.domains = structuredClone(value); }],
  ["source", (payload, value) => { payload.quoteAttribution = structuredClone(value); }],
  ["use", (payload, value) => { payload.use = structuredClone(value); }],
  ["purpose", (payload, value) => { payload.purpose = structuredClone(value); }],
  ["usage", (payload, value) => { payload.usage = structuredClone(value); }],
  ["origin", (payload, value) => { payload.origin = structuredClone(value); }],
  ["status", (payload, value) => { payload.status = structuredClone(value); }],
  ["location", (payload, value) => { payload.location = structuredClone(value); }],
  ["weakness", (payload, value) => { payload.weakness = structuredClone(value); }],
  ["use_case", (payload, value) => { payload.useCase = structuredClone(value); }],
  ["arrival", (payload, value) => { payload.arrival = structuredClone(value); }],
  ["awakening_condition", (payload, value) => { payload.awakeningCondition = structuredClone(value); }],
  ["behavior", (payload, value) => { payload.behavior = structuredClone(value); }],
  ["condition", (payload, value) => { payload.condition = structuredClone(value); }],
  ["form", (payload, value) => { payload.form = structuredClone(value); }],
  ["nature", (payload, value) => { payload.nature = structuredClone(value); }],
  ["role", (payload, value) => { payload.role = structuredClone(value); }],
  ["progression", (payload, value) => { payload.progression = structuredClone(value); }],
];

export class LoreScopeError extends Error {}

export function resolveCthulhuDatasetPath(options: DatasetLoadOptions = {}): string {
  const configured = options.datasetPath ?? process.env.CTHULHU_DATASET_PATH ?? DEFAULT_DATASET_PATH;
  const resolved = isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), configured);
  (options.report ?? console.info)(`[cthulhu-dataset] resolved path: ${resolved}`);
  return resolved;
}

export function loadCthulhuDataset(
  manifest: CthulhuDatasetManifest = CTHULHU_DATASET_MANIFEST,
  options: DatasetLoadOptions = {},
): CthulhuDatasetLoadResult {
  const root = resolveCthulhuDatasetPath(options);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Cthulhu dataset directory not found: ${root}`);

  const chapterInventory = readChapterInventory(root, manifest);
  const chapters = new Map(chapterInventory.map((entry) => [`${entry.workId}:${entry.chapter}`, entry]));
  const records: RawArtifactRecord[] = [];
  const loadedArtifacts: string[] = [];
  for (const work of manifest.works) {
    verifyFileHash(root, work.sourceText.path, work.sourceText.sha256, "source");
    const artifactPath = join(root, work.extractedArtifact.path);
    if (!existsSync(artifactPath) || statSync(artifactPath).size === 0) {
      throw new Error(`required artifact is empty or missing: ${work.extractedArtifact.path}`);
    }
    verifyFileHash(root, work.extractedArtifact.path, work.extractedArtifact.sha256, "artifact");
    const workRecords = readJsonlArtifact(root, work.extractedArtifact.path);
    if (workRecords.length !== work.extractedArtifact.expectedRows) {
      throw new Error(`artifact row count mismatch: ${work.extractedArtifact.path} expected=${work.extractedArtifact.expectedRows} actual=${workRecords.length}`);
    }
    const coveredChapters = new Set(workRecords.map((record) => record.value.chapter).filter((chapter): chapter is string => typeof chapter === "string"));
    if (coveredChapters.size !== work.extractedArtifact.expectedCoveredChapters) {
      throw new Error(`artifact chapter coverage mismatch: ${work.extractedArtifact.path} expected=${work.extractedArtifact.expectedCoveredChapters} actual=${coveredChapters.size}`);
    }
    records.push(...workRecords);
    loadedArtifacts.push(work.extractedArtifact.path);
  }
  assertNoDuplicateClaims(records);

  verifyFileHash(root, manifest.aggregateArtifact.path, manifest.aggregateArtifact.sha256, "analysis artifact");
  const analysisArtifacts: AnalysisArtifactResult[] = [{
    path: manifest.aggregateArtifact.path,
    status: manifest.aggregateArtifact.status,
    loaded: false,
  }];

  const rejectedRecords: RejectedLoreRecord[] = [];
  const candidates: LoreClaimCandidate[] = [];
  for (const record of records) {
    try {
      candidates.push(normalizeLoreRecord(record, manifest, chapters));
    } catch (error) {
      rejectedRecords.push({
        artifactPath: record.artifactPath,
        line: record.line,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ignoredArtifacts = manifest.ignoredArtifacts.map((artifact) => {
    verifyFileHash(root, artifact.path, artifact.sha256, "ignored artifact");
    const bytes = statSync(join(root, artifact.path)).size;
    if (bytes !== 0) throw new Error(`ignored_empty_legacy_artifact is no longer empty: ${artifact.path}`);
    return { path: artifact.path, status: artifact.status, loaded: false as const };
  });

  return {
    loaded: candidates.length > 0,
    resolvedPath: root,
    evidencePrecision: manifest.evidencePrecision,
    candidates,
    rejectedRecords,
    chapterInventory,
    loadedArtifacts,
    analysisArtifacts,
    ignoredArtifacts,
  };
}

export function readChapterInventory(root: string, manifest: CthulhuDatasetManifest): ChapterInventoryEntry[] {
  const entries: ChapterInventoryEntry[] = [];
  for (const work of manifest.works) {
    const workEntries: ChapterInventoryEntry[] = [];
    const directory = join(root, work.chapterDirectory);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`chapter directory missing: ${work.chapterDirectory}`);
    const names = readdirSync(directory);
    const textNames = names.filter((name) => /^ch\d{3}\.txt$/.test(name)).sort();
    const metadataNames = names.filter((name) => /^ch\d{3}\.meta\.json$/.test(name)).sort();
    const pairs = validateChapterPairs(work, textNames, metadataNames);
    for (let index = 0; index < pairs.length; index++) {
      const { chapter, textName, metadataName } = pairs[index];
      const chunkPath = `${work.chapterDirectory}/${textName}`;
      const metadataPath = `${work.chapterDirectory}/${metadataName}`;
      const text = readFileSync(join(root, chunkPath), "utf8");
      const metadataText = readFileSync(join(root, metadataPath), "utf8");
      const metadata = parseChapterMetadata(JSON.parse(metadataText), work.workId, index + 1, textName);
      if (metadata.line_count !== metadata.end_line - metadata.start_line + 1) throw new Error(`metadata line count mismatch: ${metadataPath}`);
      if (text.length !== metadata.chars) throw new Error(`metadata char count mismatch: ${metadataPath}`);
      if (!(text.split(/\r?\n/)[0] ?? "").trim().startsWith(metadata.first_line)) throw new Error(`metadata first line mismatch: ${metadataPath}`);
      workEntries.push({ workId: work.workId, chapter, chunkPath, metadataPath, metadata, textHash: sha256(text), metadataHash: sha256(metadataText) });
    }
    const inventoryHash = sha256(JSON.stringify(workEntries.map((entry) => ({
      chapter: entry.chapter,
      textSha256: entry.textHash,
      metadataSha256: entry.metadataHash,
    }))));
    if (inventoryHash !== work.chapterInventorySha256) throw new Error(`chapter inventory hash mismatch: ${work.workId}`);
    entries.push(...workEntries);
  }
  return entries;
}

export function readJsonlArtifact(root: string, relativePath: string): RawArtifactRecord[] {
  const path = join(root, relativePath);
  if (!existsSync(path)) throw new Error(`artifact missing: ${relativePath}`);
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed)) throw new Error(`artifact row must be object: ${relativePath}:${index + 1}`);
    return [{ artifactPath: relativePath, line: index + 1, value: parsed }];
  });
}

export function validateChapterPairs(
  work: CthulhuWorkManifest,
  textNames: string[],
  metadataNames: string[],
): Array<{ chapter: string; textName: string; metadataName: string }> {
  if (textNames.length !== work.expectedChapters || metadataNames.length !== work.expectedChapters) {
    throw new Error(`chapter pair count mismatch for ${work.workId}: text=${textNames.length} metadata=${metadataNames.length}`);
  }
  return Array.from({ length: work.expectedChapters }, (_, index) => {
    const chapter = `ch${String(index + 1).padStart(3, "0")}`;
    const textName = `${chapter}.txt`;
    const metadataName = `${chapter}.meta.json`;
    if (textNames[index] !== textName || metadataNames[index] !== metadataName) {
      throw new Error(`chapter sequence/pair mismatch for ${work.workId}: expected ${chapter}`);
    }
    return { chapter, textName, metadataName };
  });
}

export function assertNoDuplicateClaims(records: RawArtifactRecord[]): void {
  const seen = new Map<string, RawArtifactRecord>();
  for (const record of records) {
    const key = canonicalJson(withoutDndMapping(record.value));
    const previous = seen.get(key);
    if (previous) {
      throw new Error(`duplicate claim: ${previous.artifactPath}:${previous.line} and ${record.artifactPath}:${record.line}`);
    }
    seen.set(key, record);
  }
}

export function queryLoreCandidates(
  manifest: CthulhuDatasetManifest,
  request: LoreQueryRequest,
  options: DatasetLoadOptions = {},
): LoreClaimCandidate[] {
  return selectLoreCandidates(manifest, request, loadCthulhuDataset(manifest, options));
}

/**
 * Applies the exact public query contract to a previously verified dataset.
 * Runtime callers may share immutable parsed data, but never bypass manifest,
 * work-scope, corpus-scope, or transfer-policy checks while doing so.
 */
export function selectLoreCandidates(
  manifest: CthulhuDatasetManifest,
  request: LoreQueryRequest,
  loaded: Pick<CthulhuDatasetLoadResult, "candidates">,
): LoreClaimCandidate[] {
  if (request.allowedWorkIds.length === 0) throw new LoreScopeError("allowedWorkIds must not be empty");
  const manifestIds = new Set(manifest.works.map((work) => work.workId));
  for (const workId of request.allowedWorkIds) {
    if (!manifestIds.has(workId)) throw new LoreScopeError(`work is not in manifest: ${workId}`);
  }
  const corpus = request.corpusScopeId == null
    ? undefined
    : manifest.corpusScopes.find((scope) => scope.id === request.corpusScopeId);
  if (request.corpusScopeId != null) {
    if (!corpus) throw new LoreScopeError(`corpusScopeId is not in manifest: ${request.corpusScopeId}`);
    const corpusIds = new Set(corpus.allowedWorkIds);
    if (request.allowedWorkIds.some((workId) => !corpusIds.has(workId))) {
      throw new LoreScopeError(`corpus scope does not allow all requested works: ${corpus.id}`);
    }
  }
  if (request.allowedWorkIds.length > 1) {
    if (request.transferPolicy !== "analogy_only") {
      throw new LoreScopeError("cross-work query requires analogy_only transferPolicy");
    }
    if (!corpus) throw new LoreScopeError("cross-work query requires an explicit manifest corpusScopeId");
  }
  const allowed = new Set(request.allowedWorkIds);
  const names = request.entityNames?.map((name) => name.toLocaleLowerCase("en-US"));
  const claimTypes = request.claimTypes ? new Set(request.claimTypes) : undefined;
  const domainTypes = DOMAIN_TYPES[request.domain];
  return loaded.candidates
    .filter((candidate) => allowed.has(candidate.workId))
    .filter((candidate) => domainTypes.has(candidate.type))
    .filter((candidate) => !claimTypes || claimTypes.has(candidate.type))
    .filter((candidate) => !names || names.includes(candidate.name.toLocaleLowerCase("en-US")))
    .filter((candidate) => !request.chapter || candidate.chapter === request.chapter)
    .filter((candidate) => !request.era || candidate.scope.era === request.era)
    .filter((candidate) => request.transferPolicy !== "mechanic_only" || MECHANIC_TYPES.has(candidate.type))
    .map((candidate) => ({
      ...candidate,
      scope: {
        ...candidate.scope,
        transferPolicy: request.transferPolicy,
        canFillPlotFacts: request.transferPolicy === "plot_fact",
      },
    }));
}

export function normalizeLoreRecord(
  record: RawArtifactRecord,
  manifest: CthulhuDatasetManifest,
  chapters: Map<string, ChapterInventoryEntry>,
): LoreClaimCandidate {
  const raw = record.value;
  const type = requiredString(raw.type, "type");
  const name = requiredString(raw.name, "name");
  const workId = requiredString(raw.novel, "novel") as CthulhuWorkId;
  const chapter = requiredString(raw.chapter, "chapter");
  const work = manifest.works.find((entry) => entry.workId === workId);
  if (!work) throw new Error(`unknown workId: ${workId}`);
  const inventory = chapters.get(`${workId}:${chapter}`);
  if (!inventory) throw new Error(`chapter evidence not found: ${workId}/${chapter}`);
  if (typeof raw.game_rule !== "boolean") throw new Error("game_rule must be boolean");

  const payload: LoreClaimPayload = { extractionFlags: { gameRule: raw.game_rule }, extras: {} };
  for (const [sourceKey, setValue] of KNOWN_PAYLOAD_FIELDS) {
    const value = raw[sourceKey];
    if (value !== undefined) setValue(payload, value);
  }
  if (raw.properties !== undefined) {
    if (!Array.isArray(raw.properties) && !isJsonObject(raw.properties)) throw new Error("properties must be object or array");
    payload.properties = structuredClone(raw.properties);
  }
  const reserved = new Set(["type", "name", "novel", "chapter", "era", "game_rule", "dnd_mapping", "confidence", "extraction_model", "properties", ...KNOWN_PAYLOAD_FIELDS.map(([key]) => key)]);
  for (const [key, value] of Object.entries(raw)) {
    if (!reserved.has(key)) payload.extras[key] = structuredClone(value);
  }

  const warnings = ["game_rule is an extraction annotation; candidate is not an executable RPG rule"];
  if (raw.dnd_mapping !== undefined) warnings.push("dnd_mapping excluded from lore payload; ruleset adapter provenance is unknown");
  const extractionModel = typeof raw.extraction_model === "string" ? raw.extraction_model : undefined;
  if (!extractionModel) warnings.push("extraction model not recorded in artifact");
  const confidence = typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0.5;
  if (raw.confidence === undefined) warnings.push("confidence not recorded; adapter default 0.5");
  const era = typeof raw.era === "string" ? raw.era : undefined;
  return {
    id: `${manifest.datasetId}:${workId}:${chapter}:${String(record.line).padStart(4, "0")}`,
    type,
    name,
    workId,
    chapter,
    evidenceSpan: {
      sourceHash: work.sourceText.sha256,
      chapter,
      chunkPath: inventory.chunkPath,
      startLine: inventory.metadata.start_line,
      endLine: inventory.metadata.end_line,
      textHash: inventory.textHash,
    },
    payload,
    authority: "declared_canon",
    derivation: "inferred",
    status: "candidate",
    confidence,
    ...(extractionModel ? { extractionModel } : {}),
    scope: { workId, chapter, ...(era ? { era } : {}), evidencePrecision: "chunk", transferPolicy: "unassigned", canFillPlotFacts: false },
    rightsEvidence: {
      sourcePath: work.licenseEvidence.sourcePath,
      statementLocation: work.licenseEvidence.statementLocation,
      statement: work.licenseEvidence.statement,
      rightsStatus: "unknown",
    },
    warnings,
  };
}

function parseChapterMetadata(value: unknown, workId: CthulhuWorkId, chapter: number, file: string): ChapterMetadata {
  if (!isJsonObject(value)) throw new Error(`chapter metadata must be object: ${workId}/${chapter}`);
  const metadata: ChapterMetadata = {
    chapter: requiredNumber(value.chapter, "chapter"),
    novel: requiredString(value.novel, "novel") as CthulhuWorkId,
    start_line: requiredNumber(value.start_line, "start_line"),
    end_line: requiredNumber(value.end_line, "end_line"),
    line_count: requiredNumber(value.line_count, "line_count"),
    first_line: requiredString(value.first_line, "first_line"),
    file: requiredString(value.file, "file"),
    chars: requiredNumber(value.chars, "chars"),
  };
  if (metadata.chapter !== chapter || metadata.novel !== workId || metadata.file !== file) {
    throw new Error(`chapter metadata identity mismatch: ${workId}/ch${String(chapter).padStart(3, "0")}`);
  }
  return metadata;
}

function verifyFileHash(root: string, relativePath: string, expected: string, label: string): void {
  const path = join(root, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} missing: ${relativePath}`);
  const actual = sha256(readFileSync(path));
  if (actual !== expected) throw new Error(`${label} hash mismatch: ${relativePath}`);
}

function sha256(value: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function withoutDndMapping(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "dnd_mapping"));
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
