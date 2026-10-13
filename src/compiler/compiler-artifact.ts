import {
  COMPILER_QUESTION_QUEUE_SCHEMA_VERSION,
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  CompilerQuestionError,
  buildCompilerQuestionQueue,
  validateCompilerQuestionQueue,
  validateModuleCompileHints,
  type CompilerQuestionQueue,
  type ModuleCompileHints,
} from "./compiler-question-queue";
import { resolveDraftModule, type ResolvedClueFactFacetBinding, type ResolvedDraftModule, type ResolvedItemBinding, type ResolvedProseDialogueClue, type ResolvedProseNpcBinding, type ResolvedRewardBinding, type ResolvedSourceFactMechanicBinding } from "./compile-hint-resolution";
import { DRAFT_MODULE_STRUCTURE_SCHEMA_VERSION, compileDeterministicTemplates, type DraftModuleStructure } from "./deterministic-template-compiler";
import { MECHANICS_IR_SCHEMA_VERSION, MechanicsCompilationError, sourceFactGraphIdentity, validateMechanicsIR, type MechanicsIR } from "./mechanics-ir";
import { MechanicsReachabilityError, type MechanicsReachabilityReport } from "./mechanics-reachability";
import { validateMechanicsAnalysisInput, type MechanicsAnalysisInput } from "./mechanics-execution";
import { SOURCE_FACT_GRAPH_SCHEMA_VERSION, validateSourceFactGraph, type FactInterpretationCandidate, type SourceFactGraph } from "./source-fact-graph";
import {
  SOURCE_FACT_DISPOSITION_REPORT_SCHEMA_VERSION,
  buildPreparedSourceFactDispositionReport,
  buildResolvedSourceFactDispositionReport,
  validateSourceFactDispositionReport,
  type SourceFactDispositionReport,
} from "./source-fact-disposition";
import { DOCUMENT_IR_SCHEMA_VERSION, sha256, validateDocumentIR } from "../ingest/document-ir";

export const COMPILER_ARTIFACT_SCHEMA_VERSION = "1.0.0";
export const COMPILER_ARTIFACT_ANALYSIS_INPUT_SCHEMA_VERSION = "1.0.0";
export const COMPILER_ARTIFACT_REACHABILITY_REPORT_SCHEMA_VERSION = "1.1.0";

export interface CompilerArtifactComponentVersions {
  documentIR: typeof DOCUMENT_IR_SCHEMA_VERSION;
  sourceFactGraph: typeof SOURCE_FACT_GRAPH_SCHEMA_VERSION;
  draft: typeof DRAFT_MODULE_STRUCTURE_SCHEMA_VERSION;
  preparedQueue: typeof COMPILER_QUESTION_QUEUE_SCHEMA_VERSION;
  hints: typeof MODULE_COMPILE_HINTS_SCHEMA_VERSION;
  mechanicsIR: typeof MECHANICS_IR_SCHEMA_VERSION;
  analysisInput: typeof COMPILER_ARTIFACT_ANALYSIS_INPUT_SCHEMA_VERSION;
  reachabilityReport: typeof COMPILER_ARTIFACT_REACHABILITY_REPORT_SCHEMA_VERSION;
  sourceFactDispositionReport: typeof SOURCE_FACT_DISPOSITION_REPORT_SCHEMA_VERSION;
}

export interface PreparedCompilerArtifactIdentity {
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  preparedQueueHash: string;
}

export interface ResolvedCompilerArtifactIdentity extends PreparedCompilerArtifactIdentity {
  resolvedQueueHash: string;
  mechanicsHash: string;
}

export interface PreparedCompilerArtifactPayload {
  identity: PreparedCompilerArtifactIdentity;
  graph: SourceFactGraph;
  draft: DraftModuleStructure;
  preparedQueue: CompilerQuestionQueue;
  /** Prepared-stage canonical source whole-statement accounting. */
  sourceFactDispositionReport: SourceFactDispositionReport;
}

export interface ResolvedCompilerArtifactPayload extends PreparedCompilerArtifactPayload {
  identity: ResolvedCompilerArtifactIdentity;
  hints: ModuleCompileHints;
  resolvedQueue: CompilerQuestionQueue;
  acceptedInterpretations: FactInterpretationCandidate[];
  substitutedEnginePolicyInterpretationIds: string[];
  proseNpcBindings: ResolvedProseNpcBinding[];
  proseDialogueClues: ResolvedProseDialogueClue[];
  itemBindings: ResolvedItemBinding[];
  rewardBindings: ResolvedRewardBinding[];
  sourceFactMechanicBindings: ResolvedSourceFactMechanicBinding[];
  clueFactFacetBindings: ResolvedClueFactFacetBinding[];
  mechanicsIR: MechanicsIR;
  analysisInput: MechanicsAnalysisInput;
  reachabilityReport: MechanicsReachabilityReport;
  readiness: ResolvedDraftModule["readiness"];
  /** Recomputed from the effective resolved queue and accepted runtime bindings. */
  resolvedSourceFactDispositionReport: SourceFactDispositionReport;
}

export interface CompilerArtifactEnvelope {
  schemaVersion: typeof COMPILER_ARTIFACT_SCHEMA_VERSION;
  stage: "prepared" | "resolved";
  componentVersions: CompilerArtifactComponentVersions;
  artifactHash: string;
  payload: PreparedCompilerArtifactPayload | ResolvedCompilerArtifactPayload;
}

export type CompilerArtifactRefusalCode =
  | "ARTIFACT_PARSE_FAILED"
  | "ARTIFACT_SCHEMA_MISMATCH"
  | "ARTIFACT_COMPONENT_VERSION_MISMATCH"
  | "ARTIFACT_HASH_MISMATCH"
  | "ARTIFACT_IDENTITY_SUBSTITUTION"
  | "PREPARED_SOURCE_INVALID"
  | "PREPARED_IDENTITY_MISMATCH"
  | "PREPARED_DRAFT_MISMATCH"
  | "PREPARED_QUEUE_MISMATCH"
  | "PREPARED_DISPOSITION_REPORT_MISMATCH"
  | "RESOLVED_HINTS_INVALID"
  | "RESOLVED_NOT_CLOSED"
  | "RESOLVED_IDENTITY_MISMATCH"
  | "RESOLVED_SNAPSHOT_MISMATCH";

export interface CompilerArtifactRefusal {
  status: "refused";
  stage: "parse" | "prepared" | "resolved";
  code: CompilerArtifactRefusalCode;
  message: string;
  causeCode?: string;
}

export type RestoredCompilerArtifact =
  | { status: "restored"; stage: "prepared"; artifactHash: string; payload: PreparedCompilerArtifactPayload }
  | { status: "restored"; stage: "resolved"; artifactHash: string; payload: ResolvedCompilerArtifactPayload };

/**
 * Bounded envelope/hash check for a validator-child result.  Unlike restore it
 * deliberately does not regenerate a graph, draft, or queue in the caller's
 * process; the disposable validator already performed that expensive work.
 */
export type VerifiedPreparedCompilerArtifact =
  | { status: "verified"; artifactHash: string; identity: PreparedCompilerArtifactIdentity }
  | CompilerArtifactRefusal;

export class CompilerArtifactDataError extends Error {
  constructor(readonly code: CompilerArtifactRefusalCode, message: string) {
    super(message);
    this.name = "CompilerArtifactDataError";
  }
}

const COMPONENT_VERSIONS: CompilerArtifactComponentVersions = {
  documentIR: DOCUMENT_IR_SCHEMA_VERSION,
  sourceFactGraph: SOURCE_FACT_GRAPH_SCHEMA_VERSION,
  draft: DRAFT_MODULE_STRUCTURE_SCHEMA_VERSION,
  preparedQueue: COMPILER_QUESTION_QUEUE_SCHEMA_VERSION,
  hints: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  mechanicsIR: MECHANICS_IR_SCHEMA_VERSION,
  analysisInput: COMPILER_ARTIFACT_ANALYSIS_INPUT_SCHEMA_VERSION,
  reachabilityReport: COMPILER_ARTIFACT_REACHABILITY_REPORT_SCHEMA_VERSION,
  sourceFactDispositionReport: SOURCE_FACT_DISPOSITION_REPORT_SCHEMA_VERSION,
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CompilerArtifactDataError("ARTIFACT_PARSE_FAILED", "artifact JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new CompilerArtifactDataError("ARTIFACT_PARSE_FAILED", "artifact JSON contains a non-plain value");
  return `{${Object.keys(value).sort().map((key) => {
    const nested = (value as Record<string, unknown>)[key];
    if (nested === undefined) throw new CompilerArtifactDataError("ARTIFACT_PARSE_FAILED", `artifact JSON contains undefined: ${key}`);
    return `${JSON.stringify(key)}:${canonicalJson(nested)}`;
  }).join(",")}}`;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function omitArtifactHash(envelope: Omit<CompilerArtifactEnvelope, "artifactHash"> | CompilerArtifactEnvelope): Omit<CompilerArtifactEnvelope, "artifactHash"> {
  const { artifactHash: _artifactHash, ...withoutHash } = envelope as CompilerArtifactEnvelope;
  return withoutHash;
}

/** The artifact identity is a named envelope hash, separate from queue, mechanics, and state hashes. */
export function compilerArtifactIdentity(envelope: Omit<CompilerArtifactEnvelope, "artifactHash"> | CompilerArtifactEnvelope): string {
  return sha256(canonicalJson(omitArtifactHash(envelope)));
}

export function sealCompilerArtifact(envelope: Omit<CompilerArtifactEnvelope, "artifactHash">): CompilerArtifactEnvelope {
  const artifactHash = compilerArtifactIdentity(envelope);
  return { ...jsonClone(envelope), artifactHash };
}

export function serializeCompilerArtifact(envelope: CompilerArtifactEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function refusal(stage: CompilerArtifactRefusal["stage"], code: CompilerArtifactRefusalCode, error: unknown): CompilerArtifactRefusal {
  const candidate = error as { code?: unknown };
  return {
    status: "refused",
    stage,
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof candidate?.code === "string" ? { causeCode: candidate.code } : {}),
  };
}

function expectedDataError(error: unknown): boolean {
  if (error instanceof CompilerArtifactDataError || error instanceof CompilerQuestionError || error instanceof MechanicsCompilationError || error instanceof MechanicsReachabilityError) return true;
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError) return false;
  return error instanceof Error && /^(unsupported (DocumentIR|graph) schema:|invalid (DocumentIR|PDF DocumentIR)|synthetic DocumentIR|DocumentIR (page hash|page identity)|evidence |duplicate Source|SourceStatement |SourceRelation |interpretation |accepted interpretation |review |accept review |conflicting interpretation |draft_queue_)/.test(error.message);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompilerArtifactDataError("ARTIFACT_PARSE_FAILED", `artifact ${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new CompilerArtifactDataError("ARTIFACT_PARSE_FAILED", `artifact ${label} has undeclared field: ${key}`);
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CompilerArtifactDataError("ARTIFACT_PARSE_FAILED", `artifact ${label} must be a non-empty string`);
  return value;
}

function decodeEnvelope(value: unknown): CompilerArtifactEnvelope {
  const envelope = assertRecord(value, "envelope");
  assertKeys(envelope, ["schemaVersion", "stage", "componentVersions", "artifactHash", "payload"], "envelope");
  if (envelope.schemaVersion !== COMPILER_ARTIFACT_SCHEMA_VERSION) throw new CompilerArtifactDataError("ARTIFACT_SCHEMA_MISMATCH", `unsupported artifact schema: ${String(envelope.schemaVersion)}`);
  if (envelope.stage !== "prepared" && envelope.stage !== "resolved") throw new CompilerArtifactDataError("ARTIFACT_SCHEMA_MISMATCH", "artifact stage is invalid");
  assertString(envelope.artifactHash, "artifactHash");
  const componentVersions = assertRecord(envelope.componentVersions, "componentVersions");
  assertKeys(componentVersions, Object.keys(COMPONENT_VERSIONS), "componentVersions");
  if (!sameSnapshot(componentVersions, COMPONENT_VERSIONS)) throw new CompilerArtifactDataError("ARTIFACT_COMPONENT_VERSION_MISMATCH", "unsupported artifact component versions");
  const payload = assertRecord(envelope.payload, "payload");
  const preparedKeys = ["identity", "graph", "draft", "preparedQueue", "sourceFactDispositionReport"];
  const resolvedKeys = [...preparedKeys, "hints", "resolvedQueue", "acceptedInterpretations", "substitutedEnginePolicyInterpretationIds", "proseNpcBindings", "proseDialogueClues", "itemBindings", "rewardBindings", "sourceFactMechanicBindings", "clueFactFacetBindings", "mechanicsIR", "analysisInput", "reachabilityReport", "readiness", "resolvedSourceFactDispositionReport"];
  assertKeys(payload, envelope.stage === "prepared" ? preparedKeys : resolvedKeys, "payload");
  for (const key of preparedKeys) if (!(key in payload)) throw new CompilerArtifactDataError("ARTIFACT_PARSE_FAILED", `artifact payload is missing ${key}`);
  if (envelope.stage === "resolved") for (const key of resolvedKeys) if (!(key in payload)) throw new CompilerArtifactDataError("ARTIFACT_PARSE_FAILED", `resolved artifact payload is missing ${key}`);
  const decoded = envelope as unknown as CompilerArtifactEnvelope;
  if (compilerArtifactIdentity(decoded) !== decoded.artifactHash) throw new CompilerArtifactDataError("ARTIFACT_HASH_MISMATCH", "artifactHash does not match canonical envelope");
  return decoded;
}

export function verifyPreparedCompilerArtifactEnvelope(value: unknown): VerifiedPreparedCompilerArtifact {
  try {
    const envelope = decodeEnvelope(value);
    if (envelope.stage !== "prepared") return refusal("parse", "ARTIFACT_SCHEMA_MISMATCH", "prepared artifact required");
    const identity = envelope.payload.identity;
    if (!identity || typeof identity.moduleId !== "string" || !identity.moduleId.trim()
      || (typeof identity.documentHash !== "string" && identity.documentHash !== null)
      || typeof identity.sourceGraphIdentity !== "string" || !identity.sourceGraphIdentity
      || typeof identity.preparedQueueHash !== "string" || !/^[a-f0-9]{64}$/.test(identity.preparedQueueHash)) {
      return refusal("parse", "ARTIFACT_IDENTITY_SUBSTITUTION", "prepared artifact identity is malformed");
    }
    return { status: "verified", artifactHash: envelope.artifactHash, identity: jsonClone(identity) };
  } catch (error) {
    if (expectedDataError(error)) return refusal("parse", error instanceof CompilerArtifactDataError ? error.code : "ARTIFACT_PARSE_FAILED", error);
    throw error;
  }
}

function validatePreparedIdentity(payload: PreparedCompilerArtifactPayload): void {
  const identity = payload.identity;
  if (!identity || !identity.moduleId?.trim() || identity.documentHash !== payload.graph.documentIdentity.documentHash || identity.sourceGraphIdentity !== sourceFactGraphIdentity(payload.graph) || identity.preparedQueueHash !== payload.preparedQueue.queueHash) {
    throw new CompilerArtifactDataError("PREPARED_IDENTITY_MISMATCH", "prepared artifact identity does not agree with its graph or queue");
  }
}

function regeneratePrepared(payload: PreparedCompilerArtifactPayload): PreparedCompilerArtifactPayload {
  validateDocumentIR(payload.graph.documentIdentity);
  validateSourceFactGraph(payload.graph);
  validatePreparedIdentity(payload);
  validateCompilerQuestionQueue(payload.graph, payload.preparedQueue);
  const draft = compileDeterministicTemplates(payload.graph, { moduleId: payload.identity.moduleId });
  if (!sameSnapshot(draft, payload.draft)) throw new CompilerArtifactDataError("PREPARED_DRAFT_MISMATCH", "persisted draft differs from deterministic regeneration");
  const preparedQueue = buildCompilerQuestionQueue(payload.graph, draft);
  if (!sameSnapshot(preparedQueue, payload.preparedQueue)) throw new CompilerArtifactDataError("PREPARED_QUEUE_MISMATCH", "persisted prepared queue differs from deterministic regeneration");
  const sourceFactDispositionReport = buildPreparedSourceFactDispositionReport(payload.graph, draft, preparedQueue);
  try {
    validateSourceFactDispositionReport(payload.graph, payload.sourceFactDispositionReport);
  } catch (error) {
    throw new CompilerArtifactDataError("PREPARED_DISPOSITION_REPORT_MISMATCH", error instanceof Error ? error.message : "persisted prepared source disposition report is invalid");
  }
  if (!sameSnapshot(sourceFactDispositionReport, payload.sourceFactDispositionReport)) {
    throw new CompilerArtifactDataError("PREPARED_DISPOSITION_REPORT_MISMATCH", "persisted prepared source disposition report differs from deterministic regeneration");
  }
  return { identity: jsonClone(payload.identity), graph: jsonClone(payload.graph), draft, preparedQueue, sourceFactDispositionReport };
}

function requireClosed(resolved: ResolvedDraftModule): asserts resolved is ResolvedDraftModule & Required<Pick<ResolvedDraftModule, "mechanicsIR" | "analysisInput" | "reachabilityReport">> {
  if (resolved.readiness.status !== "mechanically_closed" || !resolved.mechanicsIR || !resolved.analysisInput || !resolved.reachabilityReport || resolved.reachabilityReport.analysisScope !== "closed_world" || resolved.reachabilityReport.selectedTerminalEndingIds.length === 0 || resolved.reachabilityReport.unreachableCoreClueIds.length || resolved.reachabilityReport.unreachableEndingIds.length || resolved.reachabilityReport.deadlockWitnesses.length || resolved.reachabilityReport.failurePolicyRiskMethodIds.length) {
    throw new CompilerArtifactDataError("RESOLVED_NOT_CLOSED", "resolved artifact is not mechanically closed with a terminal report");
  }
}

function resolvePrepared(prepared: PreparedCompilerArtifactPayload, hints: ModuleCompileHints): ResolvedCompilerArtifactPayload {
  try {
    validateModuleCompileHints(prepared.preparedQueue, hints, prepared.graph);
  } catch (error) {
    if (expectedDataError(error)) throw new CompilerArtifactDataError("RESOLVED_HINTS_INVALID", error instanceof Error ? error.message : String(error));
    throw error;
  }
  const resolved = resolveDraftModule(prepared.graph, prepared.draft, prepared.preparedQueue, hints);
  requireClosed(resolved);
  validateMechanicsIR(resolved.mechanicsIR);
  validateMechanicsAnalysisInput(resolved.mechanicsIR, resolved.analysisInput);
  const identity: ResolvedCompilerArtifactIdentity = {
    ...prepared.identity,
    resolvedQueueHash: resolved.resolvedQueue.queueHash,
    mechanicsHash: resolved.mechanicsIR.mechanicsHash,
  };
  const resolvedSourceFactDispositionReport = buildResolvedSourceFactDispositionReport(prepared.graph, prepared.draft, resolved.resolvedQueue, resolved.acceptedInterpretations, {
    proseNpcBindings: resolved.proseNpcBindings,
    itemBindings: resolved.itemBindings,
    rewardBindings: resolved.rewardBindings,
    sourceFactMechanicBindings: resolved.sourceFactMechanicBindings,
  });
  return {
    ...prepared,
    identity,
    hints: jsonClone(hints),
    resolvedQueue: resolved.resolvedQueue,
    acceptedInterpretations: resolved.acceptedInterpretations,
    substitutedEnginePolicyInterpretationIds: resolved.substitutedEnginePolicyInterpretationIds,
    proseNpcBindings: resolved.proseNpcBindings,
    proseDialogueClues: resolved.proseDialogueClues,
    itemBindings: resolved.itemBindings,
    rewardBindings: resolved.rewardBindings,
    sourceFactMechanicBindings: resolved.sourceFactMechanicBindings,
    clueFactFacetBindings: resolved.clueFactFacetBindings,
    mechanicsIR: resolved.mechanicsIR,
    analysisInput: resolved.analysisInput,
    reachabilityReport: resolved.reachabilityReport,
    readiness: resolved.readiness,
    resolvedSourceFactDispositionReport,
  };
}

function assertResolvedMatches(payload: ResolvedCompilerArtifactPayload, regenerated: ResolvedCompilerArtifactPayload): void {
  if (payload.identity.resolvedQueueHash !== payload.resolvedQueue.queueHash || payload.identity.mechanicsHash !== payload.mechanicsIR.mechanicsHash || !sameSnapshot(payload.identity, regenerated.identity)) {
    throw new CompilerArtifactDataError("RESOLVED_IDENTITY_MISMATCH", "resolved artifact identity does not agree with its components");
  }
  const snapshots: Array<[string, unknown, unknown]> = [
    ["resolved queue", payload.resolvedQueue, regenerated.resolvedQueue],
    ["accepted interpretations", payload.acceptedInterpretations, regenerated.acceptedInterpretations],
    ["policy substitutions", payload.substitutedEnginePolicyInterpretationIds, regenerated.substitutedEnginePolicyInterpretationIds],
    ["prose NPC bindings", payload.proseNpcBindings, regenerated.proseNpcBindings],
    ["prose dialogue clues", payload.proseDialogueClues, regenerated.proseDialogueClues],
    ["item bindings", payload.itemBindings, regenerated.itemBindings],
    ["reward bindings", payload.rewardBindings, regenerated.rewardBindings],
    ["source fact mechanic bindings", payload.sourceFactMechanicBindings, regenerated.sourceFactMechanicBindings],
    ["clue fact facet bindings", payload.clueFactFacetBindings, regenerated.clueFactFacetBindings],
    ["MechanicsIR", payload.mechanicsIR, regenerated.mechanicsIR],
    ["analysis input", payload.analysisInput, regenerated.analysisInput],
    ["reachability report", payload.reachabilityReport, regenerated.reachabilityReport],
    ["readiness", payload.readiness, regenerated.readiness],
    ["resolved source fact disposition report", payload.resolvedSourceFactDispositionReport, regenerated.resolvedSourceFactDispositionReport],
  ];
  for (const [label, actual, expected] of snapshots) if (!sameSnapshot(actual, expected)) throw new CompilerArtifactDataError("RESOLVED_SNAPSHOT_MISMATCH", `persisted ${label} differs from complete re-resolution`);
}

function envelope(stage: "prepared", payload: PreparedCompilerArtifactPayload): CompilerArtifactEnvelope;
function envelope(stage: "resolved", payload: ResolvedCompilerArtifactPayload): CompilerArtifactEnvelope;
function envelope(stage: "prepared" | "resolved", payload: PreparedCompilerArtifactPayload | ResolvedCompilerArtifactPayload): CompilerArtifactEnvelope {
  return sealCompilerArtifact({ schemaVersion: COMPILER_ARTIFACT_SCHEMA_VERSION, stage, componentVersions: COMPONENT_VERSIONS, payload: jsonClone(payload) } as Omit<CompilerArtifactEnvelope, "artifactHash">);
}

export function createPreparedCompilerArtifact(source: PreparedCompilerArtifactPayload): CompilerArtifactEnvelope {
  return envelope("prepared", regeneratePrepared(jsonClone(source)));
}

export function createResolvedCompilerArtifact(source: ResolvedCompilerArtifactPayload): CompilerArtifactEnvelope {
  const prepared = regeneratePrepared(jsonClone(source));
  const regenerated = resolvePrepared(prepared, jsonClone(source.hints));
  assertResolvedMatches(source, regenerated);
  return envelope("resolved", regenerated);
}

export function resolvePreparedCompilerArtifact(prepared: PreparedCompilerArtifactPayload, hints: ModuleCompileHints): ResolvedCompilerArtifactPayload {
  const regenerated = regeneratePrepared(jsonClone(prepared));
  return jsonClone(resolvePrepared(regenerated, jsonClone(hints)));
}

export function restoreCompilerArtifact(envelopeValue: CompilerArtifactEnvelope): RestoredCompilerArtifact | CompilerArtifactRefusal {
  let envelope: CompilerArtifactEnvelope;
  try {
    envelope = decodeEnvelope(envelopeValue);
  } catch (error) {
    if (expectedDataError(error)) return refusal("parse", error instanceof CompilerArtifactDataError ? error.code : "ARTIFACT_PARSE_FAILED", error);
    throw error;
  }
  let prepared: PreparedCompilerArtifactPayload;
  try {
    prepared = regeneratePrepared(jsonClone(envelope.payload));
  } catch (error) {
    if (!expectedDataError(error)) throw error;
    return refusal("prepared", error instanceof CompilerArtifactDataError ? error.code : "PREPARED_SOURCE_INVALID", error);
  }
  if (envelope.stage === "prepared") return { status: "restored", stage: "prepared", artifactHash: envelope.artifactHash, payload: prepared };
  try {
    const resolved = jsonClone(envelope.payload) as ResolvedCompilerArtifactPayload;
    const regenerated = resolvePrepared(prepared, resolved.hints);
    assertResolvedMatches(resolved, regenerated);
    return { status: "restored", stage: "resolved", artifactHash: envelope.artifactHash, payload: regenerated };
  } catch (error) {
    if (!expectedDataError(error)) throw error;
    return refusal("resolved", error instanceof CompilerArtifactDataError ? error.code : "RESOLVED_SNAPSHOT_MISMATCH", error);
  }
}

export function restoreCompilerArtifactJson(text: string): RestoredCompilerArtifact | CompilerArtifactRefusal {
  try {
    return restoreCompilerArtifact(JSON.parse(text) as CompilerArtifactEnvelope);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CompilerArtifactDataError) return refusal("parse", "ARTIFACT_PARSE_FAILED", error);
    throw error;
  }
}
