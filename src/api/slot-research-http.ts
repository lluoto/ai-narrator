import {
  loadReviewedSlotResearchAdapter,
  type ReviewedSlotResearchAdapter,
  type ReviewedSlotResearchConfig,
  type ReviewedSlotResearchReceipt,
} from "../world/reviewed-slot-research-adapter";

export const SLOT_RESEARCH_HTTP_PATH = "/api/slot-research";

export interface SlotResearchEnvironment {
  readonly SLOT_RESEARCH_MANIFEST_PATH?: string;
  readonly SLOT_RESEARCH_MANIFEST_SHA256?: string;
  readonly SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH?: string;
  readonly SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256?: string;
  readonly SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES?: string;
}

export type SlotResearchHttpHandler = (request: Request) => Response | null;
export type SlotResearchAdapterFactory = (config: ReviewedSlotResearchConfig) => ReviewedSlotResearchAdapter;
type CachedSlotResearchBinding =
  | { readonly key: string; readonly state: "ready"; readonly adapter: ReviewedSlotResearchAdapter }
  | { readonly key: string; readonly state: "rejected" };

const RECEIPT_FIELDS = [
  "proposal",
  "verifier",
  "leadDossier",
  "sourceParentHashes",
  "workSource",
  "route",
  "reviewerClass",
  "warnings",
  "modalityScope",
] as const;
const PROPOSAL_FIELDS = ["id", "recordSha256", "recordsFileSha256"] as const;
const VERIFIER_FIELDS = ["caseId", "canonicalVerdictSha256"] as const;
const LEAD_DOSSIER_FIELDS = ["id", "lineSha256", "fileSha256"] as const;
const SOURCE_PARENT_HASH_FIELDS = [
  "parentBatchManifestSha256",
  "sourcePropositionRecordsSha256",
  "sourceSentencesSha256",
] as const;
const WORK_SOURCE_FIELDS = ["workId", "sourceUnitId", "sourceEvidenceId"] as const;
const MODALITY_SCOPE_FIELDS = [
  "assertionStatus",
  "claimantOrSource",
  "claimantStatus",
  "temporalStatus",
  "evidenceDirectness",
  "sourcePropositionExtractable",
  "generalityScope",
  "generalityCueSpan",
] as const;

/**
 * Creates the isolated HTTP facade for reviewed slot research. It owns no
 * session, prompt, rule, persistence, or runtime capability.
 */
export function createSlotResearchHttpHandler(
  environment: SlotResearchEnvironment = processSlotResearchEnvironment(),
  createAdapter: SlotResearchAdapterFactory = loadReviewedSlotResearchAdapter,
): SlotResearchHttpHandler {
  // The environment is process configuration, but retain the complete binding
  // identity in case an injected host rotates all pinned artifact values.
  // `workId` is deliberately not a cache key: it only queries the already
  // verified immutable adapter.
  let cached: CachedSlotResearchBinding | undefined;

  return (request) => {
    const url = new URL(request.url);
    if (url.pathname !== SLOT_RESEARCH_HTTP_PATH) return null;

    if (request.method !== "GET") {
      return respond({
        error: { code: "SLOT_RESEARCH_METHOD_NOT_ALLOWED", message: "slot research accepts GET only" },
      }, 405, { Allow: "GET" });
    }

    const workId = exactWorkId(url);
    if (workId === undefined) {
      return respond({
        error: { code: "SLOT_RESEARCH_QUERY_INVALID", message: "exactly one nonempty workId query is required" },
      }, 400);
    }

    const binding = bindingFromEnvironment(environment);
    if (!binding) {
      return respond({
        error: { code: "SLOT_RESEARCH_UNAVAILABLE", message: "slot research is not configured" },
      }, 503);
    }

    const key = bindingCacheKey(binding);
    let adapter: ReviewedSlotResearchAdapter;
    if (cached?.key === key) {
      if (cached.state === "rejected") return bindingRejectedResponse();
      adapter = cached.adapter;
    } else {
      try {
        adapter = createAdapter(binding);
        cached = { key, state: "ready", adapter };
      } catch {
        // A process binding cannot be made valid by a public request. Keep
        // only its identity, never validation details, until configuration
        // rotates to another complete binding.
        cached = { key, state: "rejected" };
        return bindingRejectedResponse();
      }
    }

    try {
      const receipts = adapter.queryWork(workId);
      assertReadonlyMetadataReceipts(receipts, workId);
      return respond(Object.freeze({ status: statusFor(binding.allowedReviewerClasses), receipts }));
    } catch {
      return bindingRejectedResponse();
    }
  };
}

function bindingCacheKey(binding: ReviewedSlotResearchConfig): string {
  return JSON.stringify([
    binding.manifestPath,
    binding.manifestSha256,
    binding.artifactBindingIndexPath,
    binding.artifactBindingIndexSha256,
    binding.allowedReviewerClasses,
  ]);
}

function bindingRejectedResponse(): Response {
  // Do not expose artifact paths, expected pins, or manifest validation internals.
  return respond({
    error: { code: "SLOT_RESEARCH_BINDING_REJECTED", message: "slot research is unavailable" },
  }, 503);
}

/** Uses only the current explicit process environment; no artifact is loaded at module initialization. */
const environmentHandler = createSlotResearchHttpHandler(processSlotResearchEnvironment());

export function handleSlotResearchHttpRequest(request: Request): Response | null {
  return environmentHandler(request);
}

function exactWorkId(url: URL): string | undefined {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]![0] !== "workId") return undefined;
  const workId = entries[0]![1];
  return workId.trim() ? workId : undefined;
}

function bindingFromEnvironment(environment: SlotResearchEnvironment): ReviewedSlotResearchConfig | undefined {
  const manifestPath = configuredValue(environment.SLOT_RESEARCH_MANIFEST_PATH);
  const manifestSha256 = configuredValue(environment.SLOT_RESEARCH_MANIFEST_SHA256);
  const artifactBindingIndexPath = configuredValue(environment.SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH);
  const artifactBindingIndexSha256 = configuredValue(environment.SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256);
  const allowedReviewerClasses = configuredValue(environment.SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES);
  if (!manifestPath || !manifestSha256 || !artifactBindingIndexPath || !artifactBindingIndexSha256 || !allowedReviewerClasses) {
    return undefined;
  }

  return {
    manifestPath,
    manifestSha256,
    artifactBindingIndexPath,
    artifactBindingIndexSha256,
    allowedReviewerClasses: allowedReviewerClasses.split(",").map((value) => value.trim()) as ReviewedSlotResearchConfig["allowedReviewerClasses"],
  };
}

function configuredValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function processSlotResearchEnvironment(): SlotResearchEnvironment {
  return {
    SLOT_RESEARCH_MANIFEST_PATH: process.env.SLOT_RESEARCH_MANIFEST_PATH,
    SLOT_RESEARCH_MANIFEST_SHA256: process.env.SLOT_RESEARCH_MANIFEST_SHA256,
    SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH: process.env.SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH,
    SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256: process.env.SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256,
    SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES: process.env.SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES,
  };
}

function assertReadonlyMetadataReceipts(receipts: readonly ReviewedSlotResearchReceipt[], workId: string): void {
  if (!Object.isFrozen(receipts)) throw new Error("slot research adapter returned a mutable receipt list");
  for (const receipt of receipts) {
    if (receipt.workSource.workId !== workId || !Object.isFrozen(receipt)) {
      throw new Error("slot research adapter returned an invalid receipt");
    }
    assertExactKeys(receipt, RECEIPT_FIELDS);
    assertFrozenObject(receipt.proposal, PROPOSAL_FIELDS);
    assertFrozenObject(receipt.verifier, VERIFIER_FIELDS);
    assertFrozenObject(receipt.leadDossier, LEAD_DOSSIER_FIELDS);
    assertFrozenObject(receipt.sourceParentHashes, SOURCE_PARENT_HASH_FIELDS);
    assertFrozenObject(receipt.workSource, WORK_SOURCE_FIELDS);
    assertFrozenObject(receipt.modalityScope, MODALITY_SCOPE_FIELDS);
    if (!Object.isFrozen(receipt.warnings)
      || !receipt.warnings.includes(`reviewer_class:${receipt.reviewerClass}`)
      || (receipt.reviewerClass === "lead_model" && !receipt.warnings.includes("model_reviewed_not_human_gold"))) {
      throw new Error("slot research adapter returned invalid reviewer metadata");
    }
  }
}

function statusFor(admittedReviewerClasses: ReviewedSlotResearchConfig["allowedReviewerClasses"]): Readonly<{
  readonly readOnly: true;
  readonly noRuntimeEffect: true;
  readonly admittedReviewerClasses: readonly string[];
}> {
  return Object.freeze({
    readOnly: true,
    noRuntimeEffect: true,
    admittedReviewerClasses: Object.freeze([...admittedReviewerClasses]),
  });
}

function assertFrozenObject(value: object, fields: readonly string[]): void {
  if (!Object.isFrozen(value)) throw new Error("slot research adapter returned mutable metadata");
  assertExactKeys(value, fields);
}

function assertExactKeys(value: object, fields: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error("slot research adapter returned unsupported receipt data");
  }
}

function respond(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
