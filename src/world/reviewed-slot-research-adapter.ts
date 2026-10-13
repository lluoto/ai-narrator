import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Read-only lookup for the real reviewed-slot research manifest. Referenced
 * artifacts are verified for provenance only; their contents never enter a
 * receipt or any runtime-facing data structure.
 */

export type SlotResearchReviewerClass = "human" | "delegated_assistant" | "lead_model";

export interface ReviewedSlotResearchConfig {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly artifactBindingIndexPath: string;
  readonly artifactBindingIndexSha256: string;
  /** Required, no default: which reviewer classes may be admitted. */
  readonly allowedReviewerClasses: readonly SlotResearchReviewerClass[];
}

export interface ReviewedSlotResearchModalityScope {
  readonly assertionStatus: string;
  readonly claimantOrSource: string | null;
  readonly claimantStatus: string;
  readonly temporalStatus: string;
  readonly evidenceDirectness: string;
  readonly sourcePropositionExtractable: "yes";
  readonly generalityScope: string;
  readonly generalityCueSpan: string | null;
}

/** Metadata-only receipt derived from one real manifest row. */
export interface ReviewedSlotResearchReceipt {
  readonly proposal: {
    readonly id: string;
    readonly recordSha256: string;
    readonly recordsFileSha256: string;
  };
  readonly verifier: {
    readonly caseId: string;
    readonly canonicalVerdictSha256: string;
  };
  readonly leadDossier: {
    readonly id: string;
    readonly lineSha256: string;
    readonly fileSha256: string;
  };
  readonly sourceParentHashes: {
    readonly parentBatchManifestSha256: string;
    readonly sourcePropositionRecordsSha256: string;
    readonly sourceSentencesSha256: string;
  };
  readonly workSource: {
    readonly workId: string;
    readonly sourceUnitId: string;
    readonly sourceEvidenceId: string;
  };
  readonly route: string;
  readonly reviewerClass: SlotResearchReviewerClass;
  readonly warnings: readonly string[];
  readonly modalityScope: ReviewedSlotResearchModalityScope;
}

export interface ReviewedSlotResearchAdapter {
  readonly admittedCount: number;
  readonly excludedByReviewerClass: number;
  /** Returns metadata-only receipts for one exact work ID. */
  queryWork(workId: string): readonly ReviewedSlotResearchReceipt[];
}

export class ReviewedSlotResearchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewedSlotResearchError";
  }
}

type Obj = Record<string, unknown>;
type ArtifactBinding = { readonly path: string; readonly sha256: string };
const REVIEWER_CLASSES: ReadonlySet<string> = new Set(["human", "delegated_assistant", "lead_model"]);

const CONFIG_FIELDS = [
  "manifestPath",
  "manifestSha256",
  "artifactBindingIndexPath",
  "artifactBindingIndexSha256",
  "allowedReviewerClasses",
] as const;
const MANIFEST_FIELDS = [
  "source_parent_hashes",
  "proposal",
  "verifier",
  "lead_dossier",
  "work_source",
  "route",
  "modality_scope",
  "reviewer_class",
  "publication_status",
  "transfer_policy",
  "consumer_policy",
  "no_runtime_effect",
] as const;
const SOURCE_PARENT_HASH_FIELDS = [
  "parent_batch_manifest_sha256",
  "source_proposition_records_sha256",
  "source_sentences_sha256",
  "lead_dossier_file_sha256",
] as const;
const PROPOSAL_FIELDS = ["proposal_id", "proposal_record_sha256", "proposal_records_file_sha256"] as const;
const VERIFIER_FIELDS = ["case_id", "canonical_verdict_sha256"] as const;
const LEAD_DOSSIER_FIELDS = ["dossier_id", "dossier_line_sha256"] as const;
const WORK_SOURCE_FIELDS = ["work_id", "allowed_work_ids", "source_unit_id", "source_evidence_id"] as const;
const MODALITY_SCOPE_FIELDS = [
  "assertion_status",
  "claimant_or_source",
  "claimant_status",
  "temporal_status",
  "evidence_directness",
  "source_proposition_extractable",
  "generality_scope",
  "generality_cue_span",
] as const;
const INDEX_FIELDS = ["schema_version", "manifest_sha256", "bindings"] as const;
const INDEX_BINDING_FIELDS = ["reference_sha256", "path", "file_sha256"] as const;
const EMPTY_RECEIPTS: readonly ReviewedSlotResearchReceipt[] = Object.freeze([]);
const MAX_SLOT_RESEARCH_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SLOT_RESEARCH_INDEX_BYTES = 1 * 1024 * 1024;
const MAX_SLOT_RESEARCH_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_SLOT_RESEARCH_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SLOT_RESEARCH_MANIFEST_ENTRIES = 1024;
const MAX_SLOT_RESEARCH_BINDINGS = 128;
const MAX_SLOT_RESEARCH_JSONL_ENTRIES = 8192;

/**
 * Loads one explicit, hash-pinned manifest and its separately pinned artifact
 * binding index. It has no environment lookup and imports no runtime subsystem.
 */
export function loadReviewedSlotResearchAdapter(config: ReviewedSlotResearchConfig): ReviewedSlotResearchAdapter {
  const binding = parseConfig(config);
  const manifestLines = readPinnedManifest(binding.manifestPath, binding.manifestSha256);
  const bindingsByHash = readBindingIndex(binding);
  const allReceipts: ReviewedSlotResearchReceipt[] = [];
  const proposalIds = new Set<string>();
  const verifierCaseIds = new Set<string>();
  const dossierIds = new Set<string>();

  for (const [lineNumber, line] of manifestLines) {
    const receipt = parseManifestRow(parseObject(line, `slot manifest line ${lineNumber}`), lineNumber);
    if (proposalIds.has(receipt.proposal.id)) fail(`slot manifest line ${lineNumber}`, `duplicate proposal.proposal_id ${receipt.proposal.id}`);
    if (verifierCaseIds.has(receipt.verifier.caseId)) fail(`slot manifest line ${lineNumber}`, `duplicate verifier.case_id ${receipt.verifier.caseId}`);
    if (dossierIds.has(receipt.leadDossier.id)) fail(`slot manifest line ${lineNumber}`, `duplicate lead_dossier.dossier_id ${receipt.leadDossier.id}`);
    proposalIds.add(receipt.proposal.id);
    verifierCaseIds.add(receipt.verifier.caseId);
    dossierIds.add(receipt.leadDossier.id);
    allReceipts.push(receipt);
  }

  const requiredArtifactHashes = requiredArtifactHashesFor(allReceipts);
  assertExactBindingCoverage(bindingsByHash, requiredArtifactHashes);
  const artifactSizes = captureArtifactResourceBudget(bindingsByHash);
  const lineBoundArtifactHashes = lineBoundArtifactHashesFor(allReceipts);
  for (const [referenceSha256, artifact] of bindingsByHash) {
    // Proposal and dossier files are hash-verified by their subsequent line
    // checks. Do not synchronously stream the same complete artifact twice.
    if (!lineBoundArtifactHashes.has(referenceSha256)) {
      assertPinnedOpaqueArtifact(`artifact binding ${referenceSha256}`, artifact, requiredArtifactSize(artifactSizes, referenceSha256));
    }
  }
  assertProposalRecordBindings(allReceipts, bindingsByHash, artifactSizes);
  assertLeadDossierBindings(allReceipts, bindingsByHash, artifactSizes);

  let excludedByReviewerClass = 0;
  const receipts = allReceipts.filter((receipt) => {
    if (binding.allowedReviewerClasses.has(receipt.reviewerClass)) return true;
    excludedByReviewerClass += 1;
    return false;
  });

  const byWork = new Map<string, ReviewedSlotResearchReceipt[]>();
  for (const receipt of receipts) {
    const frozenReceipt = deepFreeze(receipt);
    const workReceipts = byWork.get(frozenReceipt.workSource.workId);
    if (workReceipts) workReceipts.push(frozenReceipt);
    else byWork.set(frozenReceipt.workSource.workId, [frozenReceipt]);
  }

  const frozenByWork = new Map<string, readonly ReviewedSlotResearchReceipt[]>();
  for (const [workId, workReceipts] of byWork) frozenByWork.set(workId, Object.freeze(workReceipts));
  return Object.freeze({
    admittedCount: receipts.length,
    excludedByReviewerClass,
    queryWork(workId: string): readonly ReviewedSlotResearchReceipt[] {
      return frozenByWork.get(requiredQueryWorkId(workId)) ?? EMPTY_RECEIPTS;
    },
  } satisfies ReviewedSlotResearchAdapter);
}

function parseConfig(value: unknown): {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly artifactBindingIndexPath: string;
  readonly artifactBindingIndexSha256: string;
  readonly allowedReviewerClasses: ReadonlySet<SlotResearchReviewerClass>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewedSlotResearchError("reviewed slot research config must be an object");
  }
  const config = value as Obj;
  assertExactKeys(config, CONFIG_FIELDS, "reviewed slot research config");
  return {
    manifestPath: pathValue(config, "manifestPath", "manifest"),
    manifestSha256: hashValue(config, "manifestSha256", "manifest"),
    artifactBindingIndexPath: pathValue(config, "artifactBindingIndexPath", "artifact binding index"),
    artifactBindingIndexSha256: hashValue(config, "artifactBindingIndexSha256", "artifact binding index"),
    allowedReviewerClasses: parseAllowedReviewerClasses(config.allowedReviewerClasses),
  };
}

function readBindingIndex(config: ReturnType<typeof parseConfig>): Map<string, ArtifactBinding> {
  const index = readPinnedJson(config.artifactBindingIndexPath, config.artifactBindingIndexSha256, "artifact binding index");
  assertExactKeys(index, INDEX_FIELDS, "artifact binding index");
  expect(index, "schema_version", "reviewed_slot_research_artifact_binding_index_v1", "artifact binding index");
  if (hashValue(index, "manifest_sha256", "artifact binding index") !== config.manifestSha256) {
    fail("artifact binding index", "manifest_sha256 does not match the configured manifest pin");
  }
  if (!Array.isArray(index.bindings) || index.bindings.length === 0) {
    fail("artifact binding index", "bindings must be a nonempty array");
  }
  if (index.bindings.length > MAX_SLOT_RESEARCH_BINDINGS) {
    fail("artifact binding index bindings", `exceeds the ${MAX_SLOT_RESEARCH_BINDINGS}-entry resource limit`);
  }

  const bindingsByHash = new Map<string, ArtifactBinding>();
  for (const [bindingNumber, entry] of index.bindings.entries()) {
    const at = `artifact binding index bindings[${bindingNumber}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(at, "must be an object");
    const binding = entry as Obj;
    assertExactKeys(binding, INDEX_BINDING_FIELDS, at);
    const referenceSha256 = hashValue(binding, "reference_sha256", at);
    const fileSha256 = hashValue(binding, "file_sha256", at);
    if (referenceSha256 !== fileSha256) fail(at, "file_sha256 must equal reference_sha256");
    if (bindingsByHash.has(referenceSha256)) fail(at, `duplicate reference_sha256 ${referenceSha256}`);
    bindingsByHash.set(referenceSha256, { path: pathValue(binding, "path", at), sha256: fileSha256 });
  }
  return bindingsByHash;
}

function parseManifestRow(row: Obj, lineNumber: number): ReviewedSlotResearchReceipt {
  const at = `slot manifest line ${lineNumber}`;
  assertExactKeys(row, MANIFEST_FIELDS, at);
  const reviewerClass = str(row, "reviewer_class", at);
  if (!REVIEWER_CLASSES.has(reviewerClass)) fail(at, `unknown reviewer_class ${reviewerClass}`);
  expect(row, "publication_status", "candidate_not_confirmed", at);
  expect(row, "transfer_policy", "no_transfer", at);
  expect(row, "consumer_policy", "research_lookup_only", at);
  if (row.no_runtime_effect !== true) fail(at, "no_runtime_effect must be true");

  const sourceParentHashes = obj(row, "source_parent_hashes", at);
  assertExactKeys(sourceParentHashes, SOURCE_PARENT_HASH_FIELDS, at);
  const leadDossierFileSha256 = hashValue(sourceParentHashes, "lead_dossier_file_sha256", at);

  const proposal = obj(row, "proposal", at);
  assertExactKeys(proposal, PROPOSAL_FIELDS, at);
  const verifier = obj(row, "verifier", at);
  assertExactKeys(verifier, VERIFIER_FIELDS, at);
  const leadDossier = obj(row, "lead_dossier", at);
  assertExactKeys(leadDossier, LEAD_DOSSIER_FIELDS, at);
  const workSource = obj(row, "work_source", at);
  assertExactKeys(workSource, WORK_SOURCE_FIELDS, at);
  const workId = str(workSource, "work_id", at);
  const allowedWorkIds = strArray(workSource, "allowed_work_ids", at);
  if (allowedWorkIds.length !== 1 || allowedWorkIds[0] !== workId) {
    fail(at, "work_source.allowed_work_ids must be exactly [work_source.work_id]");
  }

  const modalityScope = obj(row, "modality_scope", at);
  assertExactKeys(modalityScope, MODALITY_SCOPE_FIELDS, at);
  expect(modalityScope, "source_proposition_extractable", "yes", at);

  return {
    proposal: {
      id: str(proposal, "proposal_id", at),
      recordSha256: hashValue(proposal, "proposal_record_sha256", at),
      recordsFileSha256: hashValue(proposal, "proposal_records_file_sha256", at),
    },
    verifier: {
      caseId: str(verifier, "case_id", at),
      canonicalVerdictSha256: hashValue(verifier, "canonical_verdict_sha256", at),
    },
    leadDossier: {
      id: str(leadDossier, "dossier_id", at),
      lineSha256: hashValue(leadDossier, "dossier_line_sha256", at),
      fileSha256: leadDossierFileSha256,
    },
    sourceParentHashes: {
      parentBatchManifestSha256: hashValue(sourceParentHashes, "parent_batch_manifest_sha256", at),
      sourcePropositionRecordsSha256: hashValue(sourceParentHashes, "source_proposition_records_sha256", at),
      sourceSentencesSha256: hashValue(sourceParentHashes, "source_sentences_sha256", at),
    },
    workSource: {
      workId,
      sourceUnitId: str(workSource, "source_unit_id", at),
      sourceEvidenceId: str(workSource, "source_evidence_id", at),
    },
    route: str(row, "route", at),
    reviewerClass: reviewerClass as SlotResearchReviewerClass,
    warnings: [
      "candidate_not_confirmed",
      "no_transfer",
      "research_lookup_only",
      `reviewer_class:${reviewerClass}`,
      ...(reviewerClass === "lead_model" ? ["model_reviewed_not_human_gold"] : []),
    ],
    modalityScope: {
      assertionStatus: str(modalityScope, "assertion_status", at),
      claimantOrSource: nullableString(modalityScope, "claimant_or_source", at),
      claimantStatus: str(modalityScope, "claimant_status", at),
      temporalStatus: str(modalityScope, "temporal_status", at),
      evidenceDirectness: str(modalityScope, "evidence_directness", at),
      sourcePropositionExtractable: "yes",
      generalityScope: str(modalityScope, "generality_scope", at),
      generalityCueSpan: nullableString(modalityScope, "generality_cue_span", at),
    },
  };
}

function parseAllowedReviewerClasses(value: unknown): ReadonlySet<SlotResearchReviewerClass> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewedSlotResearchError("allowedReviewerClasses must be an explicit nonempty list");
  }
  const allowed = new Set<SlotResearchReviewerClass>();
  for (const reviewerClass of value) {
    if (typeof reviewerClass !== "string" || !REVIEWER_CLASSES.has(reviewerClass)) {
      throw new ReviewedSlotResearchError(`unknown reviewer class ${String(reviewerClass)}`);
    }
    allowed.add(reviewerClass as SlotResearchReviewerClass);
  }
  return allowed;
}

function requiredArtifactHashesFor(receipts: readonly ReviewedSlotResearchReceipt[]): Set<string> {
  const hashes = new Set<string>();
  for (const receipt of receipts) {
    hashes.add(receipt.proposal.recordsFileSha256);
    hashes.add(receipt.verifier.canonicalVerdictSha256);
    hashes.add(receipt.leadDossier.fileSha256);
    hashes.add(receipt.sourceParentHashes.parentBatchManifestSha256);
    hashes.add(receipt.sourceParentHashes.sourcePropositionRecordsSha256);
    hashes.add(receipt.sourceParentHashes.sourceSentencesSha256);
  }
  return hashes;
}

function lineBoundArtifactHashesFor(receipts: readonly ReviewedSlotResearchReceipt[]): Set<string> {
  const hashes = new Set<string>();
  for (const receipt of receipts) {
    hashes.add(receipt.proposal.recordsFileSha256);
    hashes.add(receipt.leadDossier.fileSha256);
  }
  return hashes;
}

function captureArtifactResourceBudget(bindingsByHash: ReadonlyMap<string, ArtifactBinding>): ReadonlyMap<string, number> {
  let totalBytes = 0;
  const sizes = new Map<string, number>();
  for (const [referenceSha256, artifact] of bindingsByHash) {
    const size = boundedRegularFileSize(artifact.path, `artifact binding ${referenceSha256}`, MAX_SLOT_RESEARCH_ARTIFACT_BYTES);
    if (size > MAX_SLOT_RESEARCH_ARTIFACT_TOTAL_BYTES - totalBytes) {
      fail("artifact bindings", `exceed the ${MAX_SLOT_RESEARCH_ARTIFACT_TOTAL_BYTES}-byte aggregate resource limit`);
    }
    totalBytes += size;
    sizes.set(referenceSha256, size);
  }
  return sizes;
}

function requiredArtifactSize(sizes: ReadonlyMap<string, number>, referenceSha256: string): number {
  const size = sizes.get(referenceSha256);
  if (size === undefined) fail("artifact resource budget", `missing size for ${referenceSha256}`);
  return size;
}

function assertExactBindingCoverage(bindingsByHash: ReadonlyMap<string, ArtifactBinding>, requiredHashes: ReadonlySet<string>): void {
  for (const referenceSha256 of requiredHashes) {
    if (!bindingsByHash.has(referenceSha256)) fail("artifact binding index", `missing binding for ${referenceSha256}`);
  }
  for (const referenceSha256 of bindingsByHash.keys()) {
    if (!requiredHashes.has(referenceSha256)) fail("artifact binding index", `unexpected binding for ${referenceSha256}`);
  }
}

function assertProposalRecordBindings(
  receipts: readonly ReviewedSlotResearchReceipt[],
  bindingsByHash: ReadonlyMap<string, ArtifactBinding>,
  artifactSizes: ReadonlyMap<string, number>,
): void {
  const expectedByFile = new Map<string, Map<string, string>>();
  for (const receipt of receipts) {
    const expectedById = expectedByFile.get(receipt.proposal.recordsFileSha256) ?? new Map<string, string>();
    expectedById.set(receipt.proposal.id, receipt.proposal.recordSha256);
    expectedByFile.set(receipt.proposal.recordsFileSha256, expectedById);
  }
  for (const [fileSha256, expectedById] of expectedByFile) {
    assertJsonlLineBindings(
      `artifact binding ${fileSha256} proposal records`,
      requiredBinding(bindingsByHash, fileSha256),
      requiredArtifactSize(artifactSizes, fileSha256),
      "proposition_id",
      expectedById,
      false,
    );
  }
}

function assertLeadDossierBindings(
  receipts: readonly ReviewedSlotResearchReceipt[],
  bindingsByHash: ReadonlyMap<string, ArtifactBinding>,
  artifactSizes: ReadonlyMap<string, number>,
): void {
  const expectedByFile = new Map<string, Map<string, string>>();
  for (const receipt of receipts) {
    const expectedById = expectedByFile.get(receipt.leadDossier.fileSha256) ?? new Map<string, string>();
    expectedById.set(receipt.leadDossier.id, receipt.leadDossier.lineSha256);
    expectedByFile.set(receipt.leadDossier.fileSha256, expectedById);
  }
  for (const [fileSha256, expectedById] of expectedByFile) {
    assertJsonlLineBindings(
      `artifact binding ${fileSha256} lead dossier`,
      requiredBinding(bindingsByHash, fileSha256),
      requiredArtifactSize(artifactSizes, fileSha256),
      "review_dossier_id",
      expectedById,
      true,
    );
  }
}

/** Revalidates only identifier/hash lineage and discards decoded JSON immediately. */
function assertJsonlLineBindings(
  label: string,
  binding: ArtifactBinding,
  expectedSize: number,
  idField: string,
  expectedById: ReadonlyMap<string, string>,
  hashIncludesTerminator: boolean,
): void {
  const bytes = readPinnedBytes(binding.path, binding.sha256, label, MAX_SLOT_RESEARCH_ARTIFACT_BYTES, expectedSize);
  const found = new Set<string>();
  for (const [lineNumber, rawLine] of rawLines(bytes)) {
    const at = `${label} line ${lineNumber}`;
    if (isBlank(rawLine)) fail(at, "must not be blank");
    if (lineNumber > MAX_SLOT_RESEARCH_JSONL_ENTRIES) {
      fail(label, `exceeds the ${MAX_SLOT_RESEARCH_JSONL_ENTRIES}-entry resource limit`);
    }
    const row = parseObject(rawLine.toString("utf8"), at);
    const id = str(row, idField, at);
    const expectedSha256 = expectedById.get(id);
    if (expectedSha256 === undefined) continue;
    if (found.has(id)) fail(at, `ambiguous ${idField} ${id}`);
    const lineBytes = hashIncludesTerminator ? rawLine : withoutTerminator(rawLine);
    const actualSha256 = sha256(lineBytes);
    if (actualSha256 !== expectedSha256) fail(at, `${idField} ${id} line sha256 mismatch`);
    found.add(id);
  }
  for (const id of expectedById.keys()) {
    if (!found.has(id)) fail(label, `unresolved ${idField} ${id}`);
  }
}

function requiredBinding(bindingsByHash: ReadonlyMap<string, ArtifactBinding>, referenceSha256: string): ArtifactBinding {
  const binding = bindingsByHash.get(referenceSha256);
  if (!binding) fail("artifact binding index", `missing binding for ${referenceSha256}`);
  return binding;
}

function readPinnedManifest(path: string, expectedSha256: string): Array<[number, string]> {
  const bytes = readPinnedBytes(path, expectedSha256, "slot manifest", MAX_SLOT_RESEARCH_MANIFEST_BYTES);
  const lines: Array<[number, string]> = [];
  for (const [lineNumber, rawLine] of rawLines(bytes)) {
    const line = withoutTerminator(rawLine).toString("utf8");
    if (!line.trim()) fail(`slot manifest line ${lineNumber}`, "must not be blank");
    if (lines.length >= MAX_SLOT_RESEARCH_MANIFEST_ENTRIES) {
      fail("slot manifest", `exceeds the ${MAX_SLOT_RESEARCH_MANIFEST_ENTRIES}-entry resource limit`);
    }
    lines.push([lineNumber, line]);
  }
  if (lines.length === 0) fail("slot manifest", "must contain at least one record");
  return lines;
}

function readPinnedJson(path: string, expectedSha256: string, label: string): Obj {
  return parseObject(readPinnedBytes(path, expectedSha256, label, MAX_SLOT_RESEARCH_INDEX_BYTES).toString("utf8"), label);
}

function readPinnedBytes(
  path: string,
  expectedSha256: string,
  label: string,
  maximumBytes: number,
  expectedSize?: number,
): Buffer {
  const bytes = readBoundedRegularFile(path, label, maximumBytes, expectedSize);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new ReviewedSlotResearchError(`${label} sha256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  return bytes;
}

/** Symlinks may target a configured read-only file; pipes, devices, and directories may not. */
function readBoundedRegularFile(path: string, label: string, maximumBytes: number, expectedSize?: number): Buffer {
  const preOpenSize = boundedRegularFileSize(path, label, maximumBytes);
  if (expectedSize !== undefined && preOpenSize !== expectedSize) throw new ReviewedSlotResearchError(`${label} changed while reading`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const size = boundedOpenedRegularFileSize(descriptor, label, maximumBytes);
    if (expectedSize !== undefined && size !== expectedSize) throw new ReviewedSlotResearchError(`${label} changed while reading`);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(descriptor, bytes, offset, size - offset, null);
      if (bytesRead === 0) throw new ReviewedSlotResearchError(`${label} changed while reading`);
      offset += bytesRead;
    }
    if (fstatSync(descriptor).size !== size) throw new ReviewedSlotResearchError(`${label} changed while reading`);
    return bytes;
  } catch (error) {
    if (error instanceof ReviewedSlotResearchError) throw error;
    throw new ReviewedSlotResearchError(`${label} cannot be read: ${path}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function boundedRegularFileSize(path: string, label: string, maximumBytes: number): number {
  try {
    const link = lstatSync(path);
    if (!link.isFile() && !link.isSymbolicLink()) throw new ReviewedSlotResearchError(`${label} must be a regular file`);
    return boundedRegularFileStatSize(statSync(path), label, maximumBytes);
  } catch (error) {
    if (error instanceof ReviewedSlotResearchError) throw error;
    throw new ReviewedSlotResearchError(`${label} cannot be read: ${path}`, { cause: error });
  }
}

function boundedOpenedRegularFileSize(descriptor: number, label: string, maximumBytes: number): number {
  return boundedRegularFileStatSize(fstatSync(descriptor), label, maximumBytes);
}

function boundedRegularFileStatSize(stat: { isFile(): boolean; size: number }, label: string, maximumBytes: number): number {
  if (!stat.isFile()) throw new ReviewedSlotResearchError(`${label} must be a regular file`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new ReviewedSlotResearchError(`${label} has an unsafe file size`);
  if (stat.size > maximumBytes) throw new ReviewedSlotResearchError(`${label} exceeds the ${maximumBytes}-byte resource limit`);
  return stat.size;
}

/** Hashes opaque artifact bytes in chunks without decoding or retaining their contents. */
function assertPinnedOpaqueArtifact(label: string, artifact: ArtifactBinding, expectedSize: number): void {
  let descriptor: number;
  try {
    if (boundedRegularFileSize(artifact.path, label, MAX_SLOT_RESEARCH_ARTIFACT_BYTES) !== expectedSize) {
      throw new ReviewedSlotResearchError(`${label} changed while reading`);
    }
    descriptor = openSync(artifact.path, "r");
  } catch (error) {
    if (error instanceof ReviewedSlotResearchError) throw error;
    throw new ReviewedSlotResearchError(`${label} cannot be read: ${artifact.path}`, { cause: error });
  }
  try {
    const size = boundedOpenedRegularFileSize(descriptor, label, MAX_SLOT_RESEARCH_ARTIFACT_BYTES);
    if (size !== expectedSize) throw new ReviewedSlotResearchError(`${label} changed while reading`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), null);
      if (bytesRead === 0) throw new ReviewedSlotResearchError(`${label} changed while reading`);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (fstatSync(descriptor).size !== size) throw new ReviewedSlotResearchError(`${label} changed while reading`);
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== artifact.sha256) {
      throw new ReviewedSlotResearchError(`${label} sha256 mismatch: expected ${artifact.sha256}, got ${actualSha256}`);
    }
  } catch (error) {
    if (error instanceof ReviewedSlotResearchError) throw error;
    throw new ReviewedSlotResearchError(`${label} cannot be read: ${artifact.path}`, { cause: error });
  } finally {
    closeSync(descriptor);
  }
}

function* rawLines(bytes: Buffer): IterableIterator<[number, Buffer]> {
  let start = 0;
  let lineNumber = 1;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0a) {
      yield [lineNumber++, bytes.subarray(start, index + 1)];
      start = index + 1;
    }
  }
  if (start < bytes.length) yield [lineNumber, bytes.subarray(start)];
}

function withoutTerminator(line: Buffer): Buffer {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0a) end--;
  if (end > 0 && line[end - 1] === 0x0d) end--;
  return line.subarray(0, end);
}

function isBlank(line: Buffer): boolean {
  for (const byte of line) {
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return false;
  }
  return true;
}

function assertExactKeys(value: Obj, expected: readonly string[], at: string): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) fail(at, `unsupported field ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) fail(at, `missing required field ${key}`);
  }
}

function parseObject(value: string, at: string): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ReviewedSlotResearchError(`${at}: malformed JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(at, "must be an object");
  return parsed as Obj;
}

function obj(record: Obj, key: string, at: string): Obj {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(at, `${key} must be an object`);
  return value as Obj;
}

function str(record: Obj, key: string, at: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) fail(at, `${key} must be a nonempty string`);
  return value;
}

function nullableString(record: Obj, key: string, at: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") fail(at, `${key} must be a string or null`);
  return value;
}

function strArray(record: Obj, key: string, at: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    fail(at, `${key} must be a nonempty string array`);
  }
  return [...value as string[]];
}

function pathValue(record: Obj, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new ReviewedSlotResearchError(`${label} path required`);
  if (!isAbsolute(value)) throw new ReviewedSlotResearchError(`${label} path must be absolute`);
  return value;
}

function hashValue(record: Obj, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ReviewedSlotResearchError(`${label} sha256 pin required (64 lowercase hex)`);
  }
  return value;
}

function expect(record: Obj, key: string, expected: string, at: string): void {
  if (record[key] !== expected) fail(at, `${key} must be ${expected}, got ${JSON.stringify(record[key])}`);
}

function requiredQueryWorkId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ReviewedSlotResearchError("workId must be nonempty");
  return value;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(at: string, message: string): never {
  throw new ReviewedSlotResearchError(`${at}: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
