import {
  createSourceResearchFacade,
  type SourceResearchBindingConfig,
  type SourceResearchFacade,
} from "../world/source-research-facade";

export const SOURCE_RESEARCH_HTTP_PATH = "/api/source-research";

export interface SourceResearchEnvironment {
  readonly SOURCE_RESEARCH_MANIFEST_PATH?: string;
  readonly SOURCE_RESEARCH_MANIFEST_SHA256?: string;
  readonly SOURCE_RESEARCH_RECORDS_PATH?: string;
  readonly SOURCE_RESEARCH_RECORDS_SHA256?: string;
  readonly SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES?: string;
}

export type SourceResearchHttpHandler = (request: Request) => Response | null;
export type SourceResearchFacadeFactory = (config: SourceResearchBindingConfig) => SourceResearchFacade;
type CachedSourceResearchBinding =
  | { readonly key: string; readonly state: "ready"; readonly facade: SourceResearchFacade }
  | { readonly key: string; readonly state: "rejected" };

/**
 * Creates the isolated HTTP facade for reviewed-source research. It owns no
 * session, prompt, rule, persistence, or tool capability.
 */
export function createSourceResearchHttpHandler(
  environment: SourceResearchEnvironment = processResearchEnvironment(),
  createFacade: SourceResearchFacadeFactory = createSourceResearchFacade,
): SourceResearchHttpHandler {
  // The environment is process configuration, but retain the complete binding
  // identity in case an injected host rotates all pinned artifact values.
  // `workId` is deliberately not a cache key: it only queries the already
  // verified immutable facade.
  let cached: CachedSourceResearchBinding | undefined;

  return (request) => {
    const url = new URL(request.url);
    if (url.pathname !== SOURCE_RESEARCH_HTTP_PATH) return null;

    if (request.method !== "GET") {
      return respond({
        error: { code: "SOURCE_RESEARCH_METHOD_NOT_ALLOWED", message: "source research accepts GET only" },
      }, 405, { Allow: "GET" });
    }

    const workId = exactWorkId(url);
    if (workId === undefined) {
      return respond({
        error: { code: "SOURCE_RESEARCH_QUERY_INVALID", message: "exactly one nonempty workId query is required" },
      }, 400);
    }

    const binding = bindingFromEnvironment(environment);
    if (!binding) {
      return respond({
        error: { code: "SOURCE_RESEARCH_UNAVAILABLE", message: "source research is not configured" },
      }, 503);
    }

    const key = bindingCacheKey(binding);
    let facade: SourceResearchFacade;
    if (cached?.key === key) {
      if (cached.state === "rejected") return bindingRejectedResponse();
      facade = cached.facade;
    } else {
      try {
        facade = createFacade(binding);
        cached = { key, state: "ready", facade };
      } catch {
        // A process binding cannot be made valid by a public request. Keep
        // only its identity, never validation details, until configuration
        // rotates to another complete binding.
        cached = { key, state: "rejected" };
        return bindingRejectedResponse();
      }
    }

    try {
      const result = facade.query({ workId });
      return respond({ status: result.status, receipts: result.receipts });
    } catch {
      return bindingRejectedResponse();
    }
  };
}

function bindingCacheKey(binding: SourceResearchBindingConfig): string {
  return JSON.stringify([
    binding.manifestPath,
    binding.manifestSha256,
    binding.sourceRecordsPath,
    binding.sourceRecordsSha256,
    binding.allowedReviewerClasses,
  ]);
}

function bindingRejectedResponse(): Response {
  // Do not expose artifact paths, expected pins, or validation internals.
  return respond({
    error: { code: "SOURCE_RESEARCH_BINDING_REJECTED", message: "source research is unavailable" },
  }, 503);
}

/** Uses only the current explicit process environment; no artifact is loaded at module initialization. */
const environmentHandler = createSourceResearchHttpHandler(processResearchEnvironment());

export function handleSourceResearchHttpRequest(request: Request): Response | null {
  return environmentHandler(request);
}

function exactWorkId(url: URL): string | undefined {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]![0] !== "workId") return undefined;
  const workId = entries[0]![1];
  return workId.trim() ? workId : undefined;
}

function bindingFromEnvironment(environment: SourceResearchEnvironment): SourceResearchBindingConfig | undefined {
  const manifestPath = configuredValue(environment.SOURCE_RESEARCH_MANIFEST_PATH);
  const manifestSha256 = configuredValue(environment.SOURCE_RESEARCH_MANIFEST_SHA256);
  const sourceRecordsPath = configuredValue(environment.SOURCE_RESEARCH_RECORDS_PATH);
  const sourceRecordsSha256 = configuredValue(environment.SOURCE_RESEARCH_RECORDS_SHA256);
  const allowedReviewerClasses = configuredValue(environment.SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES);
  if (!manifestPath || !manifestSha256 || !sourceRecordsPath || !sourceRecordsSha256 || !allowedReviewerClasses) return undefined;

  return {
    manifestPath,
    manifestSha256,
    sourceRecordsPath,
    sourceRecordsSha256,
    allowedReviewerClasses: allowedReviewerClasses.split(",").map((value) => value.trim()) as SourceResearchBindingConfig["allowedReviewerClasses"],
  };
}

function configuredValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function processResearchEnvironment(): SourceResearchEnvironment {
  return {
    SOURCE_RESEARCH_MANIFEST_PATH: process.env.SOURCE_RESEARCH_MANIFEST_PATH,
    SOURCE_RESEARCH_MANIFEST_SHA256: process.env.SOURCE_RESEARCH_MANIFEST_SHA256,
    SOURCE_RESEARCH_RECORDS_PATH: process.env.SOURCE_RESEARCH_RECORDS_PATH,
    SOURCE_RESEARCH_RECORDS_SHA256: process.env.SOURCE_RESEARCH_RECORDS_SHA256,
    SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES: process.env.SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES,
  };
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
