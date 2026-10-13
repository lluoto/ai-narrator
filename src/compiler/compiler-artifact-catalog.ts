import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync, linkSync } from "fs";
import { dirname, join, resolve } from "path";
import { randomBytes } from "crypto";
import { restoreCompilerArtifact, type CompilerArtifactEnvelope, type PreparedCompilerArtifactIdentity, type ResolvedCompilerArtifactIdentity } from "./compiler-artifact";
import { resolveCompiler } from "./compiler-api";
import { consumePrevalidatedPreparedReceipt, type PrevalidatedPreparedReceipt } from "./compiler-pdf-prepare-isolation";
import { validateModuleCompileHints, type ModuleCompileHints } from "./compiler-question-queue";
import { sha256 } from "../ingest/document-ir";
import { validateCompiledModuleBundle } from "../api/compiled-module-bundle";
import { assertCompiledCthulhuWorldModelBindingArtifactIdentity, validateCompiledCthulhuWorldModelBinding, type CompiledCthulhuWorldModelBinding } from "../world/compiled-world-model-scope";
import { projectTrustedResolvedCompilerArtifact, trustedPresentationReviewIdentity, TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION, validateTrustedPresentationMachinePublication, type CompilerModuleDataProjection, type TrustedPresentationBinding, type TrustedPresentationMachinePublication, type TrustedPresentationReview } from "./compiler-module-data-projection";
import { CatalogCoordinatorFailure, COMPILER_ARTIFACT_CATALOG_COORDINATOR_SCHEMA_VERSION, CompilerArtifactCatalogCoordinator, type CompilerArtifactCatalogCoordinatorLike } from "./compiler-artifact-catalog-coordinator";

export const COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION = "1.0.0";
export const COMPILER_ARTIFACT_CATALOG_ID_LENGTH = 24;
export const COMPILER_ARTIFACT_CATALOG_ID_PATTERN = /^[a-z2-7]{24}$/;

export type CatalogRecoveryStage = "prepared" | "bundle" | "continuation" | "presentation-review";
type CatalogStage = CatalogRecoveryStage;
type CatalogRecord = Record<string, unknown>;

export interface CompilerArtifactCatalogFileOps {
  /** Create exactly one directory. Root initialization deliberately builds ancestors one at a time. */
  mkdir(path: string): void;
  open(path: string): number;
  write(fd: number, value: string): void;
  flush(fd: number): void;
  close(fd: number): void;
  /** Hard-link only. The caller removes the private temp separately so link ownership is never obscured by an unlink error. */
  publish(tempPath: string, targetPath: string): void;
  remove(path: string): void;
  read(path: string): string;
  list(path: string): string[];
  exists(path: string): boolean;
  isRegularFile(path: string): boolean;
  isSafeDirectory(path: string): boolean;
  /**
   * Optional directory-entry sync. `unsupported` means process-crash
   * consistency still holds, but Windows rejected directory fsync (EPERM or
   * EINVAL), so physical power-loss durability is not claimed.
   */
  syncDirectory?(path: string): "synced" | "unsupported" | void;
}

export const compilerArtifactCatalogNodeFileOps: CompilerArtifactCatalogFileOps = {
  mkdir: (path) => mkdirSync(path),
  open: (path) => openSync(path, "wx", 0o600),
  write: (fd, value) => { writeSync(fd, value, undefined, "utf8"); },
  flush: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  // link is no-clobber, unlike rename on Windows. The private temp is removed
  // by the catalog after the link succeeds, so a failed unlink cannot hide
  // that this writer owns the formal target.
  publish: (tempPath, targetPath) => { linkSync(tempPath, targetPath); },
  remove: (path) => unlinkSync(path),
  read: (path) => readFileSync(path, "utf8"),
  list: (path) => readdirSync(path),
  exists: (path) => existsSync(path),
  isRegularFile: (path) => lstatSync(path).isFile(),
  isSafeDirectory: (path) => {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  },
  syncDirectory: (path) => {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      fsyncSync(fd);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EINVAL" && code !== "EPERM") throw error;
      return "unsupported";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return "synced";
  },
};

export interface CompilerArtifactCatalogOptions {
  root?: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => string;
  generateId?: () => string;
  /** Injectable only for deterministic tests; production uses crypto entropy. */
  generateOpaqueId?: () => string;
  fileOps?: CompilerArtifactCatalogFileOps;
  /** Injectable only for coordinator lifecycle tests. */
  coordinatorFactory?: (root: string, schemaVersion: string, maxEntries: number, maxBytes: number) => CompilerArtifactCatalogCoordinatorLike;
  /** Injectable only to prove the persisted coordinator policy schema is independent of artifact JSON. */
  coordinatorSchemaVersion?: string;
}

export type CatalogRefusalCode = "CATALOG_ID_INVALID" | "CATALOG_NOT_FOUND" | "CATALOG_CORRUPT" | "CATALOG_INCOMPATIBLE" | "CATALOG_QUOTA_EXCEEDED" | "CATALOG_ID_COLLISION" | "CATALOG_BUSY" | "CATALOG_POLICY_MISMATCH" | "CATALOG_STORAGE_FAILED";
export type CatalogResult<T> = { status: "ok"; value: T } | { status: "refused"; code: CatalogRefusalCode; message: string };
/**
 * A formal target may survive a failed directory-entry sync while a revoke is
 * also uncertain. The recovery reference names only the catalog stage and ID;
 * callers must load it through their normal authenticated route.
 */
export interface CatalogWriteIndeterminate {
  status: "indeterminate";
  code: "CATALOG_DURABILITY_INDETERMINATE";
  message: string;
  recovery: { stage: CatalogRecoveryStage; id: string };
}
export type CatalogWriteResult<T> = CatalogResult<T> | CatalogWriteIndeterminate;

export interface PreparedCatalogMetadata { id: string; createdAt: string; artifactHash: string; identity: PreparedCompilerArtifactIdentity; }
export interface BundleCatalogMetadata {
  id: string;
  createdAt: string;
  artifactHash: string;
  identity: ResolvedCompilerArtifactIdentity;
  mechanicsHash: string;
  bundleHash: string;
}
/**
 * An opaque server-side handoff for validated automatic hints. Its ID has no
 * source, artifact, or identity material; the contained citations never leave
 * the catalog through an automatic-resolution response.
 */
export interface AutoResolveContinuationMetadata {
  id: string;
  createdAt: string;
  preparedArtifactId: string;
  preparedArtifactHash: string;
  preparedIdentity: PreparedCompilerArtifactIdentity;
  continuationHash: string;
  /** Host-reserved opaque targets for an automatic presentation publication. */
  machinePublication?: AutoResolveMachinePublicationReservation;
}

export interface AutoResolveMachinePublicationReservation {
  reviewId: string;
  bundleId: string;
  servicePrincipalId: string;
  policyId: string;
  resolvedArtifactHash: string;
  resolvedIdentity: ResolvedCompilerArtifactIdentity;
}
export interface LoadedPreparedCatalogEntry extends PreparedCatalogMetadata { artifact: CompilerArtifactEnvelope; }
/** The catalog loader returns the server-only binding to a durable session, never to catalog metadata clients. */
export interface LoadedBundleCatalogEntry extends BundleCatalogMetadata {
  artifact: CompilerArtifactEnvelope;
  projection: CompilerModuleDataProjection;
  /** Absent means world-model reference is deliberately disabled at runtime. */
  worldModelBinding?: CompiledCthulhuWorldModelBinding;
}
export interface LoadedAutoResolveContinuation extends AutoResolveContinuationMetadata { hints: ModuleCompileHints; }
export interface TrustedPresentationReviewMetadata {
  id: string;
  createdAt: string;
  preparedArtifactId: string;
  preparedArtifactHash: string;
  preparedIdentity: PreparedCompilerArtifactIdentity;
  resolvedArtifactHash: string;
  resolvedIdentity: ResolvedCompilerArtifactIdentity;
  reviewHash: string;
}
export interface LoadedTrustedPresentationReview extends TrustedPresentationReviewMetadata { review: TrustedPresentationReview; }

interface PreparedCatalogEnvelope extends PreparedCatalogMetadata { schemaVersion: typeof COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION; stage: "prepared"; artifact: CompilerArtifactEnvelope; }
interface BundleCatalogEnvelope extends BundleCatalogMetadata {
  schemaVersion: typeof COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION;
  stage: "bundle";
  artifact: CompilerArtifactEnvelope;
  projection: CompilerModuleDataProjection;
  worldModelBinding?: CompiledCthulhuWorldModelBinding;
}
interface AutoResolveContinuationEnvelope extends AutoResolveContinuationMetadata { schemaVersion: typeof COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION; stage: "continuation"; hints: ModuleCompileHints; }
interface TrustedPresentationReviewEnvelope extends TrustedPresentationReviewMetadata { schemaVersion: typeof COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION; stage: "presentation-review"; review: TrustedPresentationReview; }

const DEFAULT_ROOT = join("data", "compiler-catalog");
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const processLocks = new Set<string>();

function isRecord(value: unknown): value is CatalogRecord { return !!value && typeof value === "object" && !Array.isArray(value); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("catalog JSON contains a non-finite number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("catalog JSON contains a non-plain value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
/** Recompute the immutable catalog-envelope hash before a bundle becomes a durable session root. */
export function compiledBundleCatalogHash(value: LoadedBundleCatalogEntry): string {
  const { bundleHash: _bundleHash, ...entry } = value;
  return sha256(canonicalJson({
    schemaVersion: COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION,
    stage: "bundle",
    ...entry,
  }));
}
function bundleIdentity(value: Omit<BundleCatalogEnvelope, "bundleHash"> | BundleCatalogEnvelope): string {
  const { schemaVersion: _schemaVersion, stage: _stage, bundleHash: _bundleHash, ...entry } = value as BundleCatalogEnvelope;
  return compiledBundleCatalogHash(entry as LoadedBundleCatalogEntry);
}
function continuationIdentity(value: Omit<AutoResolveContinuationEnvelope, "continuationHash"> | AutoResolveContinuationEnvelope): string {
  const { continuationHash: _continuationHash, ...unsigned } = value as AutoResolveContinuationEnvelope;
  return sha256(canonicalJson(unsigned));
}
function validId(id: string): boolean { return COMPILER_ARTIFACT_CATALOG_ID_PATTERN.test(id); }
function validPreparedIdentity(value: unknown): value is PreparedCompilerArtifactIdentity {
  if (!isRecord(value) || !exactKeys(value, ["moduleId", "documentHash", "sourceGraphIdentity", "preparedQueueHash"])) return false;
  return typeof value.moduleId === "string" && !!value.moduleId.trim()
    && (typeof value.documentHash === "string" || value.documentHash === null)
    && typeof value.sourceGraphIdentity === "string" && !!value.sourceGraphIdentity.trim()
    && typeof value.preparedQueueHash === "string" && /^[a-f0-9]{64}$/.test(value.preparedQueueHash);
}
function validResolvedIdentity(value: unknown): value is ResolvedCompilerArtifactIdentity {
  if (!isRecord(value) || !exactKeys(value, ["moduleId", "documentHash", "sourceGraphIdentity", "preparedQueueHash", "resolvedQueueHash", "mechanicsHash"])) return false;
  return validPreparedIdentity({
    moduleId: value.moduleId,
    documentHash: value.documentHash,
    sourceGraphIdentity: value.sourceGraphIdentity,
    preparedQueueHash: value.preparedQueueHash,
  })
    && typeof value.resolvedQueueHash === "string" && /^[a-f0-9]{64}$/.test(value.resolvedQueueHash)
    && typeof value.mechanicsHash === "string" && /^[a-f0-9]{64}$/.test(value.mechanicsHash);
}
function validMachinePublicationReservation(value: unknown): value is AutoResolveMachinePublicationReservation {
  return isRecord(value)
    && exactKeys(value, ["reviewId", "bundleId", "servicePrincipalId", "policyId", "resolvedArtifactHash", "resolvedIdentity"])
    && typeof value.reviewId === "string" && validId(value.reviewId)
    && typeof value.bundleId === "string" && validId(value.bundleId)
    && typeof value.servicePrincipalId === "string" && !!value.servicePrincipalId.trim()
    && typeof value.policyId === "string" && !!value.policyId.trim()
    && typeof value.resolvedArtifactHash === "string" && /^[a-f0-9]{64}$/.test(value.resolvedArtifactHash)
    && validResolvedIdentity(value.resolvedIdentity);
}
function stableRefusal(code: CatalogRefusalCode, message: string): CatalogResult<never> { return { status: "refused", code, message }; }
function indeterminateWrite(stage: CatalogStage, id: string, message: string): CatalogWriteIndeterminate {
  return { status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE", message, recovery: { stage, id } };
}
function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Immutable local storage for already validated compiler artifacts; reads always replay validation. */
export class CompilerArtifactCatalog {
  readonly root: string;
  private readonly preparedRoot: string;
  private readonly bundleRoot: string;
  private readonly continuationRoot: string;
  private readonly presentationReviewRoot: string;
  private readonly ops: CompilerArtifactCatalogFileOps;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly generateOpaqueId: () => string;
  private readonly deterministicIds: boolean;
  private readonly coordinatorSchemaVersion: string;
  private readonly coordinatorFactory: (root: string, schemaVersion: string, maxEntries: number, maxBytes: number) => CompilerArtifactCatalogCoordinatorLike;

  constructor(options: CompilerArtifactCatalogOptions = {}) {
    this.root = resolve(options.root ?? process.env.COMPILER_CATALOG_ROOT ?? DEFAULT_ROOT);
    this.preparedRoot = join(this.root, "prepared");
    this.bundleRoot = join(this.root, "bundles");
    this.continuationRoot = join(this.root, "continuations");
    this.presentationReviewRoot = join(this.root, "presentation-reviews");
    this.ops = options.fileOps ?? compilerArtifactCatalogNodeFileOps;
    this.maxEntries = options.maxEntries ?? Number(process.env.COMPILER_CATALOG_MAX_ENTRIES ?? DEFAULT_MAX_ENTRIES);
    this.maxBytes = options.maxBytes ?? Number(process.env.COMPILER_CATALOG_MAX_BYTES ?? DEFAULT_MAX_BYTES);
    this.now = options.now ?? (() => new Date().toISOString());
    this.coordinatorSchemaVersion = options.coordinatorSchemaVersion ?? COMPILER_ARTIFACT_CATALOG_COORDINATOR_SCHEMA_VERSION;
    this.coordinatorFactory = options.coordinatorFactory ?? ((root, schemaVersion, maxEntries, maxBytes) => new CompilerArtifactCatalogCoordinator(root, schemaVersion, maxEntries, maxBytes));
    this.deterministicIds = !options.generateId;
    this.generateId = options.generateId ?? (() => randomBytes(24).toString("base64").replace(/[0189+=/]/g, "").slice(0, COMPILER_ARTIFACT_CATALOG_ID_LENGTH).toLowerCase());
    this.generateOpaqueId = options.generateOpaqueId ?? (() => {
      const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
      return [...randomBytes(COMPILER_ARTIFACT_CATALOG_ID_LENGTH)].map((byte) => alphabet[byte & 31]).join("");
    });
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 0 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0) throw new Error("catalog quotas must be non-negative safe integers");
  }

  savePrepared(artifactValue: unknown): CatalogWriteResult<PreparedCatalogMetadata> {
    let artifact: CompilerArtifactEnvelope;
    try {
      const restored = restoreCompilerArtifact(artifactValue as CompilerArtifactEnvelope);
      if (restored.status === "refused" || restored.stage !== "prepared") return stableRefusal("CATALOG_INCOMPATIBLE", "prepared catalog entry requires a valid prepared artifact");
      artifact = clone(artifactValue as CompilerArtifactEnvelope);
    } catch { return stableRefusal("CATALOG_INCOMPATIBLE", "prepared catalog entry requires a valid prepared artifact"); }
    const id = this.newId(`prepared:${artifact.artifactHash}`);
    if (!id) return stableRefusal("CATALOG_ID_COLLISION", "could not allocate an immutable catalog ID");
    const envelope: PreparedCatalogEnvelope = { schemaVersion: COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION, stage: "prepared", id, createdAt: this.now(), artifactHash: artifact.artifactHash, identity: clone(artifact.payload.identity as PreparedCompilerArtifactIdentity), artifact };
    return this.publish("prepared", id, envelope, (existing) => isRecord(existing) && existing.artifactHash === envelope.artifactHash) as CatalogWriteResult<PreparedCatalogMetadata>;
  }

  /**
   * Consume only a runtime-private validator receipt.  The isolation parent
   * has already bounded, hash-checked, and fully restore/rebuilt the artifact
   * in a disposable child, so replaying restore here would reintroduce the CPU
   * denial-of-service boundary this handoff is designed to remove.
   */
  savePrevalidatedPrepared(receipt: PrevalidatedPreparedReceipt): CatalogWriteResult<PreparedCatalogMetadata> {
    const receiptArtifact = consumePrevalidatedPreparedReceipt(receipt);
    if (!receiptArtifact || receiptArtifact.stage !== "prepared" || !validPreparedIdentity(receiptArtifact.payload?.identity)) {
      return stableRefusal("CATALOG_INCOMPATIBLE", "prepared catalog entry requires a validator receipt");
    }
    // consumePrevalidatedPreparedReceipt returned a fresh private JSON parse;
    // do not clone or restore it here, or the HTTP process would rebuild the
    // untrusted graph after the disposable validator already checked it.
    const artifact = receiptArtifact;
    const id = this.newId(`prepared:${artifact.artifactHash}`);
    if (!id) return stableRefusal("CATALOG_ID_COLLISION", "could not allocate an immutable catalog ID");
    const envelope: PreparedCatalogEnvelope = {
      schemaVersion: COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION,
      stage: "prepared",
      id,
      createdAt: this.now(),
      artifactHash: artifact.artifactHash,
      identity: clone(artifact.payload.identity as PreparedCompilerArtifactIdentity),
      artifact,
    };
    return this.publish("prepared", id, envelope, (existing) => isRecord(existing) && existing.artifactHash === envelope.artifactHash, true) as CatalogWriteResult<PreparedCatalogMetadata>;
  }

  saveBundle(artifactValue: unknown, projectionValue: unknown, worldModelBindingValue?: unknown, reservedId?: string): CatalogWriteResult<BundleCatalogMetadata> {
    const validated = validateCompiledModuleBundle(artifactValue, projectionValue);
    if (validated.status === "refused") return stableRefusal("CATALOG_INCOMPATIBLE", validated.message);
    let worldModelBinding: CompiledCthulhuWorldModelBinding | undefined;
    if (worldModelBindingValue !== undefined) {
      try {
        assertCompiledCthulhuWorldModelBindingArtifactIdentity(worldModelBindingValue, {
          moduleId: validated.payload.identity.moduleId,
          artifactHash: validated.artifactHash,
        });
        worldModelBinding = validateCompiledCthulhuWorldModelBinding(worldModelBindingValue);
      } catch (error) {
        return stableRefusal("CATALOG_INCOMPATIBLE", error instanceof Error ? error.message : "bundle world-model binding is invalid");
      }
    }
    if (reservedId !== undefined && !validId(reservedId)) return stableRefusal("CATALOG_ID_INVALID", "bundle reservation ID has an invalid alphabet or length");
    const id = reservedId ?? this.newId(`bundle:${validated.artifactHash}:${canonicalJson({ projection: validated.projection, worldModelBinding: worldModelBinding ?? null })}`);
    if (!id) return stableRefusal("CATALOG_ID_COLLISION", "could not allocate an immutable catalog ID");
    const artifact = clone(artifactValue as CompilerArtifactEnvelope);
    const envelope: BundleCatalogEnvelope = {
      schemaVersion: COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION,
      stage: "bundle",
      id,
      createdAt: this.now(),
      artifactHash: validated.artifactHash,
      identity: clone(validated.payload.identity),
      mechanicsHash: validated.payload.identity.mechanicsHash,
      artifact,
      projection: clone(validated.projection),
      ...(worldModelBinding ? { worldModelBinding: clone(worldModelBinding) } : {}),
      bundleHash: "",
    };
    envelope.bundleHash = bundleIdentity(envelope);
    return this.publish("bundle", id, envelope, (existing) => isRecord(existing)
      && existing.artifactHash === envelope.artifactHash
      && this.equal(existing.projection, envelope.projection)
      && this.equal(existing.worldModelBinding ?? null, envelope.worldModelBinding ?? null)) as CatalogWriteResult<BundleCatalogMetadata>;
  }

  /**
   * Retain validated automatic hints privately so an operator can later add
   * presentation through the ordinary resolve boundary. This is deliberately
   * not a resolved artifact or a public catalog resource.
   */
  saveAutoResolveContinuation(
    preparedArtifactId: string,
    artifactValue: unknown,
    hintsValue: unknown,
    machinePublication?: Omit<AutoResolveMachinePublicationReservation, "reviewId" | "bundleId">,
  ): CatalogWriteResult<AutoResolveContinuationMetadata> {
    if (!validId(preparedArtifactId)) return stableRefusal("CATALOG_ID_INVALID", "prepared artifact catalog ID has an invalid alphabet or length");
    try {
      const restored = restoreCompilerArtifact(artifactValue as CompilerArtifactEnvelope);
      if (restored.status === "refused" || restored.stage !== "prepared") return stableRefusal("CATALOG_INCOMPATIBLE", "automatic continuation requires a valid prepared artifact");
      const hints = clone(hintsValue) as ModuleCompileHints;
      validateModuleCompileHints(restored.payload.preparedQueue, hints, restored.payload.graph);
      if (machinePublication !== undefined
        && (!validMachinePublicationReservation({
          ...machinePublication,
          reviewId: "a".repeat(COMPILER_ARTIFACT_CATALOG_ID_LENGTH),
          bundleId: "b".repeat(COMPILER_ARTIFACT_CATALOG_ID_LENGTH),
        })
          || machinePublication.resolvedIdentity.moduleId !== restored.payload.identity.moduleId
          || machinePublication.resolvedIdentity.documentHash !== restored.payload.identity.documentHash
          || machinePublication.resolvedIdentity.sourceGraphIdentity !== restored.payload.identity.sourceGraphIdentity
          || machinePublication.resolvedIdentity.preparedQueueHash !== restored.payload.identity.preparedQueueHash)) {
        return stableRefusal("CATALOG_INCOMPATIBLE", "automatic publication reservation does not match the prepared artifact");
      }
      const id = this.newOpaqueId("continuation");
      if (!id) return stableRefusal("CATALOG_ID_COLLISION", "could not allocate an opaque automatic continuation ID");
      const reviewId = machinePublication ? this.newOpaqueId("presentation-review") : undefined;
      const bundleId = machinePublication ? this.newId(`machine-bundle:${machinePublication.resolvedArtifactHash}:${machinePublication.servicePrincipalId}:${machinePublication.policyId}:${id}`) : undefined;
      if (machinePublication && (!reviewId || !bundleId)) return stableRefusal("CATALOG_ID_COLLISION", "could not reserve automatic publication targets");
      const envelope: AutoResolveContinuationEnvelope = {
        schemaVersion: COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION,
        stage: "continuation",
        id,
        createdAt: this.now(),
        preparedArtifactId,
        preparedArtifactHash: restored.artifactHash,
        preparedIdentity: clone(restored.payload.identity),
        hints,
        ...(machinePublication && reviewId && bundleId ? { machinePublication: {
          ...clone(machinePublication),
          reviewId,
          bundleId,
        } } : {}),
        continuationHash: "",
      };
      envelope.continuationHash = continuationIdentity(envelope);
      return this.publish("continuation", id, envelope, (existing) => isRecord(existing) && existing.continuationHash === envelope.continuationHash) as CatalogWriteResult<AutoResolveContinuationMetadata>;
    } catch {
      return stableRefusal("CATALOG_INCOMPATIBLE", "automatic continuation requires validated compiler hints");
    }
  }

  /**
   * Persists player-visible source selections from the authenticated
   * operator/workbench review route; the principal remains host-authenticated,
   * never request-body supplied.
   */
  saveTrustedPresentationReview(
    preparedArtifactId: string,
    preparedArtifactValue: unknown,
    resolvedArtifactValue: unknown,
    reviewerPrincipalId: string,
    bindings: readonly TrustedPresentationBinding[],
    options: { reservedId?: string; machinePublication?: TrustedPresentationMachinePublication } = {},
  ): CatalogWriteResult<TrustedPresentationReviewMetadata> {
    if (!validId(preparedArtifactId) || !reviewerPrincipalId.trim()) return stableRefusal("CATALOG_ID_INVALID", "trusted presentation review requires a valid prepared ID and reviewer principal");
    try {
      const prepared = restoreCompilerArtifact(preparedArtifactValue as CompilerArtifactEnvelope);
      const resolved = restoreCompilerArtifact(resolvedArtifactValue as CompilerArtifactEnvelope);
      if (prepared.status === "refused" || prepared.stage !== "prepared" || resolved.status === "refused" || resolved.stage !== "resolved") {
        return stableRefusal("CATALOG_INCOMPATIBLE", "trusted presentation review requires validated prepared and resolved artifacts");
      }
      const preparedIdentity = prepared.payload.identity;
      const resolvedIdentity = resolved.payload.identity;
      if (resolvedIdentity.moduleId !== preparedIdentity.moduleId
        || resolvedIdentity.documentHash !== preparedIdentity.documentHash
        || resolvedIdentity.sourceGraphIdentity !== preparedIdentity.sourceGraphIdentity
        || resolvedIdentity.preparedQueueHash !== preparedIdentity.preparedQueueHash) {
        return stableRefusal("CATALOG_INCOMPATIBLE", "trusted presentation review artifact identities do not agree");
      }
      if (options.reservedId !== undefined && !validId(options.reservedId)) return stableRefusal("CATALOG_ID_INVALID", "trusted presentation review reservation ID has an invalid alphabet or length");
      const id = options.reservedId ?? this.newOpaqueId("presentation-review");
      if (!id) return stableRefusal("CATALOG_ID_COLLISION", "could not allocate a trusted presentation review ID");
      const review: TrustedPresentationReview = {
        schemaVersion: TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION,
        id,
        reviewerPrincipalId: reviewerPrincipalId.trim(),
        reviewedAt: this.now(),
        preparedArtifactId,
        preparedArtifactHash: prepared.artifactHash,
        preparedIdentity: clone(preparedIdentity),
        resolvedArtifactHash: resolved.artifactHash,
        resolvedIdentity: clone(resolvedIdentity),
        bindings: clone([...bindings]),
        ...(options.machinePublication ? { machinePublication: clone(options.machinePublication) } : {}),
        reviewHash: "",
      };
      review.reviewHash = trustedPresentationReviewIdentity(review);
      const projected = projectTrustedResolvedCompilerArtifact(resolved.payload, review);
      if (projected.status === "refused") return stableRefusal("CATALOG_INCOMPATIBLE", projected.message);
      const envelope: TrustedPresentationReviewEnvelope = {
        schemaVersion: COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION,
        stage: "presentation-review",
        id,
        createdAt: this.now(),
        preparedArtifactId,
        preparedArtifactHash: prepared.artifactHash,
        preparedIdentity: clone(preparedIdentity),
        resolvedArtifactHash: resolved.artifactHash,
        resolvedIdentity: clone(resolvedIdentity),
        reviewHash: review.reviewHash,
        review,
      };
      return this.publish("presentation-review", id, envelope, (existing) => isRecord(existing) && existing.reviewHash === envelope.reviewHash) as CatalogWriteResult<TrustedPresentationReviewMetadata>;
    } catch {
      return stableRefusal("CATALOG_INCOMPATIBLE", "trusted presentation review requires exact, heading-scoped source bindings");
    }
  }

  loadPrepared(id: string): CatalogResult<LoadedPreparedCatalogEntry> { return this.load("prepared", id) as CatalogResult<LoadedPreparedCatalogEntry>; }
  loadBundle(id: string): CatalogResult<LoadedBundleCatalogEntry> { return this.load("bundle", id) as CatalogResult<LoadedBundleCatalogEntry>; }
  loadAutoResolveContinuation(id: string): CatalogResult<LoadedAutoResolveContinuation> { return this.load("continuation", id) as CatalogResult<LoadedAutoResolveContinuation>; }
  /**
   * Continuations contain only answers that were validated at publication time.
   * Replay their validation against the catalog-restored prepared queue before a
   * resumed model call, so disk corruption cannot become a new model prompt.
   */
  validateAutoResolveContinuationHints(continuation: LoadedAutoResolveContinuation, artifactValue: unknown): CatalogResult<LoadedAutoResolveContinuation> {
    try {
      const restored = restoreCompilerArtifact(artifactValue as CompilerArtifactEnvelope);
      if (restored.status === "refused" || restored.stage !== "prepared") return stableRefusal("CATALOG_CORRUPT", "automatic continuation prepared artifact could not be restored");
      validateModuleCompileHints(restored.payload.preparedQueue, continuation.hints, restored.payload.graph);
      if (continuation.machinePublication) {
        const resolved = resolveCompiler(artifactValue as CompilerArtifactEnvelope, restored.payload.identity.preparedQueueHash, continuation.hints);
        if (resolved.status === "refused"
          || resolved.artifact.artifactHash !== continuation.machinePublication.resolvedArtifactHash
          || !this.equal(resolved.identity, continuation.machinePublication.resolvedIdentity)) {
          return stableRefusal("CATALOG_CORRUPT", "automatic publication reservation does not match the resolved compiler artifact");
        }
      }
      return { status: "ok", value: clone(continuation) };
    } catch {
      return stableRefusal("CATALOG_CORRUPT", "automatic continuation hints failed prepared-queue validation");
    }
  }
  loadTrustedPresentationReview(id: string): CatalogResult<LoadedTrustedPresentationReview> { return this.load("presentation-review", id) as CatalogResult<LoadedTrustedPresentationReview>; }

  private newId(seed: string): string | null {
    if (this.deterministicIds) return sha256(seed).slice(0, COMPILER_ARTIFACT_CATALOG_ID_LENGTH).replace(/[0-9a-f]/g, (character) => "234567abcdefghijkl"[parseInt(character, 16)]!);
    for (let attempt = 0; attempt < 8; attempt++) { const id = this.generateId(); if (validId(id)) return id; }
    return null;
  }
  /** Opaque IDs are capability references, never content hashes or cross-stage names. */
  private newOpaqueId(stage: "continuation" | "presentation-review"): string | null {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = this.generateOpaqueId();
      if (validId(id) && !this.ops.exists(this.path(stage, id))) return id;
    }
    return null;
  }
  private directory(stage: CatalogStage): string { return stage === "prepared" ? this.preparedRoot : stage === "bundle" ? this.bundleRoot : stage === "continuation" ? this.continuationRoot : this.presentationReviewRoot; }
  private path(stage: CatalogStage, id: string): string { return join(this.directory(stage), `${id}.json`); }
  private safeRoot(): boolean { return this.ops.exists(this.root) && this.ops.isSafeDirectory(this.root); }
  private safeDirectory(stage: CatalogStage): boolean { return this.ops.exists(this.directory(stage)) && this.ops.isSafeDirectory(this.directory(stage)); }
  private metadata(envelope: PreparedCatalogEnvelope | BundleCatalogEnvelope | AutoResolveContinuationEnvelope | TrustedPresentationReviewEnvelope): PreparedCatalogMetadata | BundleCatalogMetadata | AutoResolveContinuationMetadata | TrustedPresentationReviewMetadata {
    if (envelope.stage === "continuation") {
      const { schemaVersion: _schemaVersion, stage: _stage, hints: _hints, ...metadata } = envelope;
      return clone(metadata);
    }
    if (envelope.stage === "presentation-review") {
      const { schemaVersion: _schemaVersion, stage: _stage, review: _review, ...metadata } = envelope;
      return clone(metadata);
    }
    if (envelope.stage === "bundle") {
      const { schemaVersion: _schemaVersion, stage: _stage, artifact: _artifact, projection: _projection, worldModelBinding: _worldModelBinding, ...metadata } = envelope;
      return clone(metadata);
    }
    const { schemaVersion: _schemaVersion, stage: _stage, artifact: _artifact, ...metadata } = envelope as PreparedCatalogEnvelope;
    return clone(metadata);
  }
  /**
   * A publication acknowledgement is always reconstructed from the durable
   * entry.  The shallow `same` predicate below only decides whether a target
   * is an immutable collision; it is never sufficient to attest the target
   * or to manufacture the metadata returned to a caller.
   */
  private durableMetadata(stage: CatalogStage, id: string): CatalogResult<PreparedCatalogMetadata | BundleCatalogMetadata | AutoResolveContinuationMetadata | TrustedPresentationReviewMetadata> {
    const loaded = this.load(stage, id);
    if (loaded.status === "refused") return loaded;
    if (stage === "prepared") {
      const { artifact: _artifact, ...metadata } = loaded.value as LoadedPreparedCatalogEntry;
      return { status: "ok", value: clone(metadata) };
    }
    if (stage === "bundle") {
      const { artifact: _artifact, projection: _projection, worldModelBinding: _worldModelBinding, ...metadata } = loaded.value as LoadedBundleCatalogEntry;
      return { status: "ok", value: clone(metadata) };
    }
    if (stage === "continuation") {
      const { hints: _hints, ...metadata } = loaded.value as LoadedAutoResolveContinuation;
      return { status: "ok", value: clone(metadata) };
    }
    const { review: _review, ...metadata } = loaded.value as LoadedTrustedPresentationReview;
    return { status: "ok", value: clone(metadata) };
  }
  /** A publication is not acknowledged until its containing directory entry is durable. */
  private acknowledgeDurablePublication(stage: CatalogStage, id: string): CatalogResult<PreparedCatalogMetadata | BundleCatalogMetadata | AutoResolveContinuationMetadata | TrustedPresentationReviewMetadata> {
    this.ops.syncDirectory?.(this.directory(stage));
    return this.durableMetadata(stage, id);
  }
  /** Validate a durable target before deciding whether its immutable ID collides. */
  private existingPublicationOutcome(stage: CatalogStage, id: string, same: (existing: unknown) => boolean): CatalogWriteResult<PreparedCatalogMetadata | BundleCatalogMetadata | AutoResolveContinuationMetadata | TrustedPresentationReviewMetadata> {
    const loaded = this.load(stage, id);
    if (loaded.status === "refused") return loaded;
    if (!same(loaded.value)) return stableRefusal("CATALOG_ID_COLLISION", "immutable catalog ID already contains different content");
    try { return this.acknowledgeDurablePublication(stage, id); }
    catch { return indeterminateWrite(stage, id, "catalog target acknowledgement durability is uncertain; recover through the named catalog entry"); }
  }
  /**
   * Only a link that returned normally is ours to revoke. A failed revoke is
   * observable by the caller: returning a refusal while its opaque ID remains
   * loadable would otherwise create an unreachable formal capability.
   */
  private discardOwnedPublication(stage: CatalogStage, target: string): { removedAndSynced: boolean; error?: unknown } {
    let error: unknown;
    try { this.ops.remove(target); } catch (failure) { error = failure; }
    try { this.ops.syncDirectory?.(this.directory(stage)); } catch (failure) { error ??= failure; }
    return error ? { removedAndSynced: false, error } : { removedAndSynced: true };
  }
  private equal(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
  /** Build missing ancestors explicitly; recursive mkdir cannot attest each directory or its parent entry. */
  private ensureDirectory(path: string): void {
    const missing: string[] = [];
    let current = path;
    while (!this.ops.exists(current)) {
      const parent = dirname(current);
      if (parent === current) throw new Error("catalog directory has no existing ancestor");
      missing.push(current);
      current = parent;
    }
    if (!this.ops.isSafeDirectory(current)) throw new Error("catalog directory ancestor is not a real directory");
    for (const directory of missing.reverse()) {
      const parent = dirname(directory);
      if (!this.ops.isSafeDirectory(parent)) throw new Error("catalog directory parent is not a real directory");
      try { this.ops.mkdir(directory); }
      catch (error) {
        // A concurrent creator is acceptable only after a fresh, non-link directory check.
        if (!this.ops.exists(directory) || !this.ops.isSafeDirectory(directory)) throw error;
      }
      if (!this.ops.isSafeDirectory(directory)) throw new Error("catalog directory is not a real directory");
      // On Windows this may be explicitly unsupported; publication remains
      // process-crash consistent but does not claim physical power-loss durability.
      this.ops.syncDirectory?.(parent);
    }
  }
  private ensureRoot(): void { this.ensureDirectory(this.root); }
  private cleanupStalePrivateTemps(): void {
    for (const directory of [this.preparedRoot, this.bundleRoot, this.continuationRoot, this.presentationReviewRoot]) {
      if (!this.ops.exists(directory)) continue;
      if (!this.ops.isSafeDirectory(directory)) throw new Error("catalog stage directory is not a real directory");
      let removed = false;
      for (const name of this.ops.list(directory)) {
        if (!/^[a-z2-7]{24}\.json\.[a-f0-9]{16}\.tmp$/.test(name)) continue;
        const path = join(directory, name);
        if (!this.ops.isRegularFile(path)) throw new Error("catalog private temporary is not a regular file");
        this.ops.remove(path);
        removed = true;
      }
      if (removed) this.ops.syncDirectory?.(directory);
    }
  }
  private removePrivateTemp(_stage: CatalogStage, temp: string): void {
    try { this.ops.remove(temp); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  private syncFormalTargetStage(stage: CatalogStage): void {
    this.ops.syncDirectory?.(this.directory(stage));
  }
  /**
   * A validator receipt already established semantic validity off-process, but
   * an acknowledged catalog ID must still name the exact bytes that reached
   * durable storage.  This intentionally avoids JSON parsing and artifact
   * restoration in the request process.
   */
  private prevalidatedDurableMetadata(stage: CatalogStage, id: string, envelope: PreparedCatalogEnvelope | BundleCatalogEnvelope | AutoResolveContinuationEnvelope | TrustedPresentationReviewEnvelope, text: string): CatalogResult<PreparedCatalogMetadata | BundleCatalogMetadata | AutoResolveContinuationMetadata | TrustedPresentationReviewMetadata> {
    if (stage !== "prepared" || this.ops.read(this.path(stage, id)) !== text) {
      return stableRefusal("CATALOG_CORRUPT", "catalog prepared entry did not retain its validated bytes");
    }
    return { status: "ok", value: this.metadata(envelope) };
  }
  private usage(): { entries: number; bytes: number } {
    let entries = 0, bytes = 0;
    for (const dir of [this.preparedRoot, this.bundleRoot, this.continuationRoot, this.presentationReviewRoot]) {
      if (!this.ops.exists(dir)) continue;
      if (!this.ops.isSafeDirectory(dir)) throw new Error("catalog stage directory is not a real directory");
      for (const name of this.ops.list(dir)) {
        if (!/^[a-z2-7]{24}\.json$/.test(name)) continue;
        const path = join(dir, name);
        if (!this.ops.isRegularFile(path)) continue;
        entries++; bytes += new TextEncoder().encode(this.ops.read(path)).length;
      }
    }
    return { entries, bytes };
  }
  private publish(stage: CatalogStage, id: string, envelope: PreparedCatalogEnvelope | BundleCatalogEnvelope | AutoResolveContinuationEnvelope | TrustedPresentationReviewEnvelope, same: (existing: unknown) => boolean, prevalidated = false): CatalogWriteResult<PreparedCatalogMetadata | BundleCatalogMetadata | AutoResolveContinuationMetadata | TrustedPresentationReviewMetadata> {
    const lock = this.root;
    if (processLocks.has(lock)) return stableRefusal("CATALOG_BUSY", "catalog publication is already in progress");
    processLocks.add(lock);
    const target = this.path(stage, id), text = `${JSON.stringify(envelope)}\n`, temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number | undefined;
    let tempMayExist = false;
    let targetCreatedByThisPublication = false;
    let targetFullyRevalidated = false;
    let formalTargetStageSynced = false;
    let publicationBegun = false;
    let coordinator: CompilerArtifactCatalogCoordinatorLike | undefined;
    let result: CatalogWriteResult<PreparedCatalogMetadata | BundleCatalogMetadata | AutoResolveContinuationMetadata | TrustedPresentationReviewMetadata> = stableRefusal("CATALOG_STORAGE_FAILED", "catalog storage failed");
    const failClosed = (error: unknown): void => {
      if (result.status === "indeterminate") return;
      if (targetFullyRevalidated && result.status === "ok") return;
      // A fully replay-validated target is the only safe fallback when a
      // second I/O failure prevents its revocation. In particular, opaque IDs
      // must never be refused while the same call leaves a loadable entry.
      if (targetCreatedByThisPublication && !targetFullyRevalidated) {
        const cleanup = this.discardOwnedPublication(stage, target);
        if (!cleanup.removedAndSynced) {
          const durable = this.durableMetadata(stage, id);
          if (durable.status === "ok" && formalTargetStageSynced) {
            targetFullyRevalidated = true;
            result = durable;
            return;
          }
          result = indeterminateWrite(stage, id, "catalog target durability is uncertain; recover through the named catalog entry");
          return;
        }
      }
      const code = error instanceof CatalogCoordinatorFailure ? error.code : "CATALOG_STORAGE_FAILED";
      result = stableRefusal(code, error instanceof Error ? error.message : "catalog storage failed");
    };
    try {
      // Root creation happens before SQLite exists. Each newly created segment
      // is checked and its parent synced before the next segment or lock file.
      this.ensureRoot();
      coordinator = this.coordinatorFactory(this.root, this.coordinatorSchemaVersion, this.maxEntries, this.maxBytes);
      coordinator.initializePolicy();
      // Even a pre-created root and stage require a post-policy root entry
      // sync before a writer can create artifacts below them.
      this.ops.syncDirectory?.(this.root);
      coordinator.beginPublication();
      publicationBegun = true;
      this.ensureDirectory(this.directory(stage));
      if (!this.safeRoot() || !this.safeDirectory(stage)) throw new Error("catalog root or stage directory is not a real directory");
      // This is intentionally inside BEGIN IMMEDIATE: a crash's private files
      // are cleaned without racing another writer, and unknown files survive.
      this.cleanupStalePrivateTemps();
      if (this.ops.exists(target)) {
        result = this.existingPublicationOutcome(stage, id, same);
        formalTargetStageSynced = result.status === "ok";
      } else {
        const usage = this.usage(), bytes = new TextEncoder().encode(text).length;
        if (usage.entries + 1 > this.maxEntries || usage.bytes + bytes > this.maxBytes) {
          result = stableRefusal("CATALOG_QUOTA_EXCEEDED", "catalog entry or byte quota would be exceeded");
        } else {
          tempMayExist = true;
          fd = this.ops.open(temp); this.ops.write(fd, text); this.ops.flush(fd); this.ops.close(fd); fd = undefined;
          let publishedByThisCall = false;
          try {
            this.ops.publish(temp, target);
            // `publish` is link-only: ownership is established before the
            // separately fallible private-temp unlink.
            publishedByThisCall = true;
            targetCreatedByThisPublication = true;
          }
          catch (error) {
            if (this.ops.exists(target)) {
              result = this.existingPublicationOutcome(stage, id, same);
              formalTargetStageSynced = result.status === "ok";
            } else throw error;
          }
          // A normal hard-link publish owns this target. A throwing publish
          // may have observed a race winner, which is never ours to remove.
          if (publishedByThisCall && this.ops.exists(target)) {
            // Temp removal and its directory sync precede the durable reload:
            // opaque IDs never become externally successful before this point.
            this.removePrivateTemp(stage, temp);
            tempMayExist = false;
            try { this.syncFormalTargetStage(stage); }
            catch (error) {
              // A retry can compensate one transient directory sync failure;
              // read-back alone never substitutes for this barrier.
              try { this.syncFormalTargetStage(stage); formalTargetStageSynced = true; }
              catch { throw error; }
            }
            formalTargetStageSynced = true;
            const durable = prevalidated
              ? this.prevalidatedDurableMetadata(stage, id, envelope, text)
              : this.durableMetadata(stage, id);
            if (durable.status === "refused") {
              const cleanup = this.discardOwnedPublication(stage, target);
              if (!cleanup.removedAndSynced) result = indeterminateWrite(stage, id, "catalog target durability is uncertain; recover through the named catalog entry");
              else result = durable;
            }
            else targetFullyRevalidated = true;
            if (durable.status === "ok") result = durable;
          }
        }
      }
    } catch (error) {
      failClosed(error);
    } finally {
      if (fd !== undefined) {
        try { this.ops.close(fd); }
        catch (error) { failClosed(error); }
      }
      if (tempMayExist) {
        try { this.removePrivateTemp(stage, temp); this.syncFormalTargetStage(stage); }
        catch (error) { failClosed(error); }
      }
      if (coordinator) {
        const finish = coordinator.finishPublication();
        if (finish.closeFailure) {
          // A close failure cannot prove lock release, but it does not make a
          // fully replay-validated formal entry unsafe to name. Returning its
          // durable metadata avoids refused-but-loadable opaque capabilities;
          // subsequent writers will still fail busy until SQLite releases it.
          if (result.status !== "ok" && result.status !== "indeterminate") result = stableRefusal("CATALOG_STORAGE_FAILED", finish.closeFailure.message);
        } else if (finish.rollbackFailure && !publicationBegun) {
          result = stableRefusal("CATALOG_STORAGE_FAILED", finish.rollbackFailure.message);
        }
      }
      processLocks.delete(lock);
    }
    return result;
  }
  private load(stage: CatalogStage, id: string): CatalogResult<LoadedPreparedCatalogEntry | LoadedBundleCatalogEntry | LoadedAutoResolveContinuation | LoadedTrustedPresentationReview> {
    if (!validId(id)) return stableRefusal("CATALOG_ID_INVALID", "catalog ID has an invalid alphabet or length");
    const target = this.path(stage, id);
    try {
      if (this.ops.exists(this.root) && !this.safeRoot()) return stableRefusal("CATALOG_CORRUPT", "catalog root is not a real directory");
      if (this.ops.exists(this.directory(stage)) && !this.safeDirectory(stage)) return stableRefusal("CATALOG_CORRUPT", "catalog stage directory is not a real directory");
      if (!this.ops.exists(target)) return stableRefusal("CATALOG_NOT_FOUND", "catalog entry was not found");
      if (!this.ops.isRegularFile(target)) return stableRefusal("CATALOG_CORRUPT", "catalog entry is not a regular file");
      const envelope = JSON.parse(this.ops.read(target)) as unknown;
      if (!isRecord(envelope) || envelope.schemaVersion !== COMPILER_ARTIFACT_CATALOG_SCHEMA_VERSION || envelope.stage !== stage || envelope.id !== id || typeof envelope.createdAt !== "string") return stableRefusal("CATALOG_INCOMPATIBLE", "catalog envelope schema, stage, or ID is invalid");
      if (stage === "presentation-review") {
        const presentation = envelope as unknown as TrustedPresentationReviewEnvelope;
        if (!exactKeys(presentation, ["schemaVersion", "stage", "id", "createdAt", "preparedArtifactId", "preparedArtifactHash", "preparedIdentity", "resolvedArtifactHash", "resolvedIdentity", "reviewHash", "review"])
          || !validId(presentation.preparedArtifactId)
          || typeof presentation.preparedArtifactHash !== "string" || !/^[a-f0-9]{64}$/.test(presentation.preparedArtifactHash)
          || !validPreparedIdentity(presentation.preparedIdentity)
          || typeof presentation.resolvedArtifactHash !== "string" || !/^[a-f0-9]{64}$/.test(presentation.resolvedArtifactHash)
          || !isRecord(presentation.resolvedIdentity)
          || typeof presentation.reviewHash !== "string" || !/^[a-f0-9]{64}$/.test(presentation.reviewHash)
          || !isRecord(presentation.review)
          || presentation.review.id !== id
          || presentation.review.reviewHash !== presentation.reviewHash
          || presentation.reviewHash !== trustedPresentationReviewIdentity(presentation.review)) {
          return stableRefusal("CATALOG_CORRUPT", "trusted presentation review schema or hash is invalid");
        }
        const review = presentation.review;
        if (review.schemaVersion !== TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION
          || review.preparedArtifactId !== presentation.preparedArtifactId
          || review.preparedArtifactHash !== presentation.preparedArtifactHash
          || !this.equal(review.preparedIdentity, presentation.preparedIdentity)
          || review.resolvedArtifactHash !== presentation.resolvedArtifactHash
           || !this.equal(review.resolvedIdentity, presentation.resolvedIdentity)
           || !Array.isArray(review.bindings)
           || !validateTrustedPresentationMachinePublication(review)
           || typeof review.reviewerPrincipalId !== "string" || !review.reviewerPrincipalId.trim()
          || typeof review.reviewedAt !== "string" || Number.isNaN(Date.parse(review.reviewedAt))) {
          return stableRefusal("CATALOG_CORRUPT", "trusted presentation review identity is invalid");
        }
        return { status: "ok", value: clone({ ...this.metadata(presentation), review }) as LoadedTrustedPresentationReview };
      }
      if (stage === "continuation") {
        const continuation = envelope as unknown as AutoResolveContinuationEnvelope;
        const continuationKeys = ["schemaVersion", "stage", "id", "createdAt", "preparedArtifactId", "preparedArtifactHash", "preparedIdentity", "hints", "continuationHash", ...(continuation.machinePublication === undefined ? [] : ["machinePublication"])] as const;
        if (!exactKeys(continuation, continuationKeys)
          || !validId(continuation.preparedArtifactId)
          || typeof continuation.preparedArtifactHash !== "string" || !/^[a-f0-9]{64}$/.test(continuation.preparedArtifactHash)
          || !validPreparedIdentity(continuation.preparedIdentity)
          || (continuation.machinePublication !== undefined && !validMachinePublicationReservation(continuation.machinePublication))
          || !isRecord(continuation.hints)
          || typeof continuation.continuationHash !== "string" || !/^[a-f0-9]{64}$/.test(continuation.continuationHash)
          || continuation.continuationHash !== continuationIdentity(continuation)) {
          return stableRefusal("CATALOG_CORRUPT", "automatic continuation schema or hash is invalid");
        }
        return { status: "ok", value: clone({ ...this.metadata(continuation), hints: continuation.hints }) as LoadedAutoResolveContinuation };
      }
      if (typeof envelope.artifactHash !== "string" || !isRecord(envelope.identity)) return stableRefusal("CATALOG_INCOMPATIBLE", "catalog artifact envelope identity is invalid");
      if (stage === "prepared") {
        if (!exactKeys(envelope, ["schemaVersion", "stage", "id", "createdAt", "artifactHash", "identity", "artifact"])) return stableRefusal("CATALOG_INCOMPATIBLE", "prepared catalog envelope has unknown or missing fields");
        const restored = restoreCompilerArtifact(envelope.artifact as CompilerArtifactEnvelope);
        if (restored.status === "refused" || restored.stage !== "prepared" || envelope.artifactHash !== restored.artifactHash || !this.equal(envelope.identity, restored.payload.identity)) return stableRefusal("CATALOG_CORRUPT", "prepared catalog entry failed artifact revalidation");
        return { status: "ok", value: clone({ ...this.metadata(envelope as unknown as PreparedCatalogEnvelope), artifact: envelope.artifact }) as LoadedPreparedCatalogEntry };
      }
      const bundle = envelope as unknown as BundleCatalogEnvelope;
      const expectedBundleKeys = ["schemaVersion", "stage", "id", "createdAt", "artifactHash", "identity", "mechanicsHash", "artifact", "projection", "bundleHash", ...(bundle.worldModelBinding === undefined ? [] : ["worldModelBinding"])] as const;
      if (!exactKeys(bundle, expectedBundleKeys) || typeof bundle.mechanicsHash !== "string") return stableRefusal("CATALOG_INCOMPATIBLE", "bundle catalog envelope has unknown or missing fields");
      if (typeof bundle.bundleHash !== "string" || bundle.bundleHash !== bundleIdentity(bundle) || bundle.mechanicsHash !== (bundle.identity as ResolvedCompilerArtifactIdentity)?.mechanicsHash) return stableRefusal("CATALOG_CORRUPT", "bundle catalog hash or mechanics identity is invalid");
      const validated = validateCompiledModuleBundle(bundle.artifact, bundle.projection);
      if (validated.status === "refused" || validated.artifactHash !== bundle.artifactHash || !this.equal(validated.payload.identity, bundle.identity)) return stableRefusal("CATALOG_CORRUPT", "bundle catalog entry failed artifact or projection revalidation");
      let worldModelBinding: CompiledCthulhuWorldModelBinding | undefined;
      if (bundle.worldModelBinding !== undefined) {
        try {
          assertCompiledCthulhuWorldModelBindingArtifactIdentity(bundle.worldModelBinding, {
            moduleId: validated.payload.identity.moduleId,
            artifactHash: validated.artifactHash,
          });
          worldModelBinding = validateCompiledCthulhuWorldModelBinding(bundle.worldModelBinding);
        } catch (error) {
          return stableRefusal("CATALOG_CORRUPT", error instanceof Error ? error.message : "bundle world-model binding is invalid");
        }
      }
      return { status: "ok", value: clone({ ...this.metadata(bundle), artifact: bundle.artifact, projection: bundle.projection, ...(worldModelBinding ? { worldModelBinding } : {}) }) as LoadedBundleCatalogEntry };
    } catch (error) { return stableRefusal("CATALOG_CORRUPT", error instanceof Error ? error.message : "catalog entry could not be decoded"); }
  }
}
