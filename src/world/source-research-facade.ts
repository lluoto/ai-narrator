import {
  loadReviewedSourceQueryAdapter,
  type ReviewerClass,
  type SourceResearchReceipt,
} from "./reviewed-source-query-adapter";

/** Explicit, hash-pinned binding. This facade has no defaults or environment lookup. */
export interface SourceResearchBindingConfig {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly sourceRecordsPath: string;
  readonly sourceRecordsSha256: string;
  readonly allowedReviewerClasses: readonly ReviewerClass[];
}

/** Research is always scoped to exactly one caller-supplied work. */
export interface SourceResearchQuery {
  readonly workId: string;
}

export interface SourceResearchFacadeStatus {
  readonly kind: "source_research_facade_status";
  readonly state: "ready";
  readonly admittedReceiptCount: number;
  readonly noRuntimeEffect: true;
  readonly readOnly: true;
}

export interface SourceResearchResult {
  readonly status: SourceResearchFacadeStatus;
  readonly receipts: readonly SourceResearchReceipt[];
}

/** The complete public surface is a work-scoped read plus immutable status. */
export interface SourceResearchFacade {
  readonly status: SourceResearchFacadeStatus;
  query(request: SourceResearchQuery): SourceResearchResult;
}

export class SourceResearchFacadeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceResearchFacadeError";
  }
}

const BINDING_FIELDS = new Set([
  "manifestPath",
  "manifestSha256",
  "sourceRecordsPath",
  "sourceRecordsSha256",
  "allowedReviewerClasses",
]);
const MUTATION_METHODS = new Set(["apply", "commit", "delete", "execute", "insert", "mutate", "remove", "save", "set", "update", "write"]);

/**
 * Creates an isolated research-only facade over the reviewed manifest adapter.
 * No state, rules, prompt, HTTP, SQLite, or tool capability is accepted here.
 */
export function createSourceResearchFacade(config: SourceResearchBindingConfig): SourceResearchFacade {
  const binding = parseBinding(config);
  let adapter;
  try {
    adapter = loadReviewedSourceQueryAdapter({
      manifestPath: binding.manifestPath,
      manifestSha256: binding.manifestSha256,
      recordsPath: binding.sourceRecordsPath,
      recordsSha256: binding.sourceRecordsSha256,
      allowedReviewerClasses: binding.allowedReviewerClasses,
    });
  } catch (error) {
    throw bindingError(error);
  }

  if (adapter.excludedByReviewerClass !== 0) {
    throw new SourceResearchFacadeError("source research binding rejected: reviewer class is not allowlisted");
  }

  const status = Object.freeze({
    kind: "source_research_facade_status",
    state: "ready",
    admittedReceiptCount: adapter.admittedCount,
    noRuntimeEffect: true,
    readOnly: true,
  } satisfies SourceResearchFacadeStatus);

  const facade = Object.freeze({
    status,
    query(request: SourceResearchQuery): SourceResearchResult {
      const workId = parseQuery(request);
      let receipts: readonly SourceResearchReceipt[];
      try {
        receipts = adapter.queryWork(workId);
      } catch (error) {
        throw bindingError(error);
      }
      assertReadonlyWorkReceipts(receipts, workId);
      return Object.freeze({ status, receipts } satisfies SourceResearchResult);
    },
  } satisfies SourceResearchFacade);

  return new Proxy(facade, {
    get(target, property, receiver) {
      if (typeof property === "string" && MUTATION_METHODS.has(property) && !Reflect.has(target, property)) {
        return () => {
          throw new SourceResearchFacadeError(`unsupported mutation method: ${property}`);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function parseBinding(value: unknown): SourceResearchBindingConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceResearchFacadeError("source research binding must be an object");
  }
  const binding = value as Record<string, unknown>;
  for (const key of Object.keys(binding)) {
    if (!BINDING_FIELDS.has(key)) throw new SourceResearchFacadeError(`unsupported source research binding field: ${key}`);
  }
  for (const key of BINDING_FIELDS) {
    if (!Object.hasOwn(binding, key)) throw new SourceResearchFacadeError(`source research binding requires ${key}`);
  }
  return {
    manifestPath: binding.manifestPath as string,
    manifestSha256: binding.manifestSha256 as string,
    sourceRecordsPath: binding.sourceRecordsPath as string,
    sourceRecordsSha256: binding.sourceRecordsSha256 as string,
    allowedReviewerClasses: binding.allowedReviewerClasses as readonly ReviewerClass[],
  };
}

function parseQuery(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceResearchFacadeError("source research query must be an object with a nonempty workId");
  }
  const query = value as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (key !== "workId") throw new SourceResearchFacadeError(`unsupported source research query field: ${key}`);
  }
  if (typeof query.workId !== "string" || !query.workId.trim()) {
    throw new SourceResearchFacadeError("workId must be nonempty");
  }
  return query.workId;
}

function assertReadonlyWorkReceipts(receipts: readonly SourceResearchReceipt[], workId: string): void {
  if (!Object.isFrozen(receipts)) throw new SourceResearchFacadeError("source research adapter returned a mutable receipt list");
  for (const receipt of receipts) {
    if (receipt.noRuntimeEffect !== true) {
      throw new SourceResearchFacadeError("source research adapter receipt is missing noRuntimeEffect");
    }
    if (receipt.workId !== workId) {
      throw new SourceResearchFacadeError(`source research adapter returned a cross-work receipt for ${receipt.workId}`);
    }
    if (!Object.isFrozen(receipt) || !Object.isFrozen(receipt.evidence) || !Object.isFrozen(receipt.evidence.ids) || !Object.isFrozen(receipt.modality) || !Object.isFrozen(receipt.warnings)) {
      throw new SourceResearchFacadeError("source research adapter returned a mutable receipt");
    }
  }
}

function bindingError(error: unknown): SourceResearchFacadeError {
  if (error instanceof SourceResearchFacadeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SourceResearchFacadeError(`source research binding rejected: ${message}`, { cause: error });
}
