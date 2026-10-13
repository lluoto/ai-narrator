import { describe, expect, test } from "bun:test";
import {
  runTwoModuleHttpCampaign,
  type HttpCampaignDocument,
  type HttpCampaignTransport,
} from "../../scripts/real-model-two-module-http-campaign";
import { sha256 } from "../ingest/document-ir";

const documents: readonly HttpCampaignDocument[] = [
  { id: "fuzu", moduleId: "campaign-fuzu", path: "memory://fuzu.pdf" },
  { id: "barn", moduleId: "campaign-barn", path: "memory://barn.pdf" },
];

const sourceBytes: ReadonlyMap<string, Uint8Array> = new Map([
  ["memory://fuzu.pdf", new TextEncoder().encode("fuzu original PDF bytes")],
  ["memory://barn.pdf", new TextEncoder().encode("barn original PDF bytes")],
]);

function catalogId(character: string): string {
  if (!/^[a-z2-7]$/.test(character)) throw new Error("test catalog ID character must be base32");
  return character.repeat(24);
}

function preparedId(id: HttpCampaignDocument["id"]): string {
  return catalogId(id === "fuzu" ? "f" : "b");
}

function requiredBytes(document: HttpCampaignDocument): Uint8Array {
  const value = sourceBytes.get(document.path);
  if (!value) throw new Error(`missing test source ${document.path}`);
  return new Uint8Array(value);
}

function identity(document: HttpCampaignDocument, bytes: Uint8Array) {
  return {
    moduleId: document.moduleId,
    documentHash: sha256(bytes),
    sourceGraphIdentity: sha256(`graph:${document.moduleId}`),
    preparedQueueHash: sha256(`queue:${document.moduleId}`),
  };
}

function preparedResponse(document: HttpCampaignDocument, bytes: Uint8Array) {
  return {
    status: "prepared",
    preparedArtifactId: preparedId(document.id),
    identity: identity(document, bytes),
    artifact: { artifactHash: sha256(`artifact:${document.id}`) },
    // These deliberately hostile fields model a transport that carries data the
    // workflow is not permitted to retain in its report.
    endpoint: "https://provider.invalid/v1",
    apiKey: "never-render-this-key",
    source: "raw PDF prose must not be retained",
  };
}

function resolvedResponse(document: HttpCampaignDocument, bytes: Uint8Array) {
  return {
    status: "resolved",
    identity: {
      ...identity(document, bytes),
      mechanicsHash: sha256(`mechanics:${document.id}`),
    },
    // A resolved artifact is deliberately not the prepared artifact: the
    // campaign must bind both identities rather than comparing these hashes.
    artifact: { artifactHash: sha256(`resolved-artifact:${document.id}`) },
    projection: { kind: "trusted-projection" },
    bundleId: catalogId(document.id === "fuzu" ? "r" : "s"),
    quality: { mechanicallyClosed: true },
    rawSource: "must not be retained by the campaign report",
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

interface RecordedRequest {
  method: string;
  pathname: string;
  query: string;
  contentType: string | null;
  body: unknown;
  bytes?: Uint8Array;
}

function makeTransport(
  responder: (request: RecordedRequest) => Response | Promise<Response>,
  options: { clock?: { now: number }; latencyMs?: number } = {},
): { transport: HttpCampaignTransport; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const transport: HttpCampaignTransport = async (request) => {
    const url = new URL(request.url);
    let bytes: Uint8Array | undefined;
    let body: unknown;
    if (request.headers.get("Content-Type") === "application/pdf") bytes = new Uint8Array(await request.arrayBuffer());
    else body = await request.json();
    const recorded = {
      method: request.method,
      pathname: url.pathname,
      query: url.search,
      contentType: request.headers.get("Content-Type"),
      body,
      ...(bytes ? { bytes } : {}),
    };
    requests.push(recorded);
    if (options.clock) options.clock.now += options.latencyMs ?? 1;
    return await responder(recorded);
  };
  return { transport, requests };
}

function allowedHashes(): string[] {
  return documents.map((document) => sha256(requiredBytes(document)));
}

describe("two-module HTTP campaign workflow", () => {
  test("uses the existing HTTP prepare and continuation contracts, isolates the two sources, and keeps a sanitized mechanics-only report", async () => {
    const clock = { now: 0 };
    const continuation = new Map<string, number>();
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) return json({ error: { code: "bad_prepare" } }, 400);
        expect(request.method).toBe("POST");
        expect(request.contentType).toBe("application/pdf");
        expect(request.bytes).toEqual(requiredBytes(document));
        return json(preparedResponse(document, request.bytes), 201);
      }
      expect(request.pathname).toBe("/api/compiler/auto-resolve");
      expect(request.method).toBe("POST");
      expect(request.contentType).toBe("application/json");
      const body = request.body as { preparedArtifactId: string; preparedQueueHash: string; autoContinuationId?: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) return json({ error: { code: "unknown_prepared" } }, 409);
      const index = continuation.get(document.id) ?? 0;
      continuation.set(document.id, index + 1);
      expect(body.preparedQueueHash).toBe(identity(document, requiredBytes(document)).preparedQueueHash);
      if (index === 0) {
        expect(Object.keys(body).sort()).toEqual(["preparedArtifactId", "preparedQueueHash"]);
        expect(body.autoContinuationId).toBeUndefined();
        return json({
          status: "draft_only",
          preparedArtifactId: body.preparedArtifactId,
          continuationId: catalogId(document.id === "fuzu" ? "c" : "d"),
          progress: true,
          rounds: [{ round: 1, queueHash: body.preparedQueueHash, status: "partial", askedQuestionIds: ["q1"], acceptedQuestionIds: ["q1"], callCount: 2 }],
          provider: { endpoint: "https://provider.invalid", model: "must-not-render" },
        });
      }
      expect(Object.keys(body).sort()).toEqual(["autoContinuationId", "preparedArtifactId", "preparedQueueHash"]);
      expect(body.autoContinuationId).toBe(catalogId(document.id === "fuzu" ? "c" : "d"));
      return json({
        status: "presentation_draft_only",
        preparedArtifactId: body.preparedArtifactId,
        continuationId: catalogId(document.id === "fuzu" ? "e" : "g"),
        progress: true,
        mechanics: { readiness: "mechanically_closed" },
        rounds: [{ round: 2, queueHash: body.preparedQueueHash, status: "complete", askedQuestionIds: ["q2"], acceptedQuestionIds: ["q2"], callCount: 1 }],
      });
    }, { clock, latencyMs: 3 });

    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      now: () => clock.now,
      readDocument: (document) => {
        clock.now += 2;
        return requiredBytes(document);
      },
    });

    expect(report.modules).toEqual([
      expect.objectContaining({ module: "fuzu", status: "mechanics_closed", autoResolveAttempts: 2, reportedProposalCalls: 3, timing: { localInputElapsedMs: 2, prepareElapsedMs: 3, autoResolveElapsedMs: 6 } }),
      expect.objectContaining({ module: "barn", status: "mechanics_closed", autoResolveAttempts: 2, reportedProposalCalls: 3, timing: { localInputElapsedMs: 2, prepareElapsedMs: 3, autoResolveElapsedMs: 6 } }),
    ]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/prepare")).toHaveLength(2);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(4);
    expect(report.modules.map((module) => module.identity?.documentHash)).toEqual(documents.map((document) => sha256(requiredBytes(document))));
    const rendered = JSON.stringify(report);
    for (const forbidden of ["provider.invalid", "never-render-this-key", "raw PDF prose", "must-not-render", preparedId("fuzu"), catalogId("c")]) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(report.autoResolveAttemptBudget).toEqual({ kind: "http_workflow_attempts_only", maxAutoResolveAttemptsPerModule: 4 });
    expect(report.schemaVersion).toBe("1.1.0");
  });

  test("stops a module on no progress and never invents a second continuation request", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      return json({
        status: "draft_only",
        preparedArtifactId: body.preparedArtifactId,
        continuationId: catalogId("h"),
        progress: false,
        rounds: [{ round: 1, queueHash: "a".repeat(64), status: "partial", askedQuestionIds: [], acceptedQuestionIds: [], callCount: 1 }],
      });
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["stopped_no_progress", "stopped_no_progress"]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(2);
  });

  test("opt-in full-quality scheduling interleaves two continuing modules without transport-held model memory", async () => {
    const autoResolveOrder: HttpCampaignDocument["id"][] = [];
    const enteredModules: HttpCampaignDocument["id"][] = [];
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string; autoContinuationId?: string };
      const document = documents.find((candidate) => preparedId(candidate.id) === body.preparedArtifactId);
      if (!document) throw new Error("unexpected auto-resolve prepared artifact");
      autoResolveOrder.push(document.id);
      if (!body.autoContinuationId) {
        return json({
          status: "draft_only",
          preparedArtifactId: body.preparedArtifactId,
          continuationId: catalogId(document.id === "fuzu" ? "m" : "n"),
          progress: true,
          rounds: [{ round: 1, queueHash: identity(document, requiredBytes(document)).preparedQueueHash, status: "partial", askedQuestionIds: ["q1"], acceptedQuestionIds: ["q1"], callCount: 1 }],
        });
      }
      return json({
        status: "presentation_draft_only",
        preparedArtifactId: body.preparedArtifactId,
        continuationId: body.autoContinuationId,
        progress: false,
        mechanics: { readiness: "mechanically_closed" },
        rounds: [{ round: 2, queueHash: identity(document, requiredBytes(document)).preparedQueueHash, status: "complete", askedQuestionIds: [], acceptedQuestionIds: [], callCount: 0 }],
      });
    });

    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      readDocument: requiredBytes,
      maxAutoResolveAttemptsPerModule: 2,
      // Full-quality host code will use this private scheduling seam to bind
      // the current module before each internal auto-resolve request. The
      // transport itself remains stateless across calls.
      interleaveAutoResolveAttempts: true,
      runAutoResolveAttempt: async ({ module }, dispatch) => {
        enteredModules.push(module);
        return await dispatch();
      },
    });

    expect(autoResolveOrder).toEqual(["fuzu", "barn", "fuzu", "barn"]);
    expect(enteredModules).toEqual(autoResolveOrder);
    expect(report.modules.map((module) => [module.module, module.status, module.autoResolveAttempts])).toEqual([
      ["fuzu", "mechanics_closed", 2],
      ["barn", "mechanics_closed", 2],
    ]);
  });

  test("rejects cross-module prepared identity before any automatic model workflow begins", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname !== "/api/compiler/prepare" || !request.bytes) throw new Error("auto resolve must not be requested");
      const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
      const document = documents.find((candidate) => candidate.moduleId === moduleId);
      if (!document) throw new Error("unexpected module");
      const result = preparedResponse(document, request.bytes);
      if (document.id === "barn") {
        result.identity.sourceGraphIdentity = sha256("graph:campaign-fuzu");
        result.artifact.artifactHash = sha256("artifact:fuzu");
      }
      return json(result, 201);
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["identity_refused", "identity_refused"]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(0);
  });

  test("rejects a prepared module or document identity mismatch before any automatic request", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname !== "/api/compiler/prepare" || !request.bytes) throw new Error("auto resolve must not be requested");
      const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
      const document = documents.find((candidate) => candidate.moduleId === moduleId);
      if (!document) throw new Error("unexpected module");
      const result = preparedResponse(document, request.bytes);
      if (document.id === "barn") result.identity.moduleId = "campaign-fuzu";
      return json(result, 201);
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["stopped_prepare_failure", "prepare_refused"]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(0);
  });

  test("requires the catalog's real opaque-ID syntax before a prepared response can enter auto resolution", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname !== "/api/compiler/prepare" || !request.bytes) throw new Error("auto resolve must not be requested");
      const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
      const document = documents.find((candidate) => candidate.moduleId === moduleId);
      if (!document) throw new Error("unexpected module");
      const result = preparedResponse(document, request.bytes);
      if (document.id === "barn") result.preparedArtifactId = "invalid-opaque-id";
      return json(result, 201);
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["stopped_prepare_failure", "prepare_refused"]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(0);
  });

  test("treats a shared prepared queue hash as cross-module identity failure before any automatic request", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname !== "/api/compiler/prepare" || !request.bytes) throw new Error("auto resolve must not be requested");
      const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
      const document = documents.find((candidate) => candidate.moduleId === moduleId);
      if (!document) throw new Error("unexpected module");
      const result = preparedResponse(document, request.bytes);
      if (document.id === "barn") result.identity.preparedQueueHash = sha256("queue:campaign-fuzu");
      return json(result, 201);
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["identity_refused", "identity_refused"]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(0);
  });

  test("fails closed on a malformed or falsely published automatic response", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      return json({ status: "published", preparedArtifactId: body.preparedArtifactId, bundleId: "must-not-be-accepted" });
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["response_refused", "response_refused"]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(2);
  });

  test("retains a fully identity-bound resolved bundle only as an explicit unconsumed handoff when no host consumer is supplied", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) throw new Error("unexpected automatic request");
      return json(resolvedResponse(document, requiredBytes(document)));
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["published_unconsumed", "published_unconsumed"]);
    expect(report.modules.map((module) => module.identity)).toEqual(documents.map((document) => expect.objectContaining({
      documentHash: sha256(requiredBytes(document)),
      preparedArtifactHash: sha256(`artifact:${document.id}`),
      resolvedArtifactHash: sha256(`resolved-artifact:${document.id}`),
      sourceGraphIdentity: identity(document, requiredBytes(document)).sourceGraphIdentity,
      preparedQueueHash: identity(document, requiredBytes(document)).preparedQueueHash,
    })));
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(2);
    const rendered = JSON.stringify(report);
    for (const forbidden of [catalogId("r"), catalogId("s"), "trusted-projection", "must not be retained"]) expect(rendered).not.toContain(forbidden);
  });

  test("hands both isolated resolved bundle handles to the host-owned consumer exactly once without reporting their opaque IDs", async () => {
    const received: Array<{ module: string; bundleId: string; preparedArtifactHash: string; resolvedArtifactHash: string }> = [];
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) throw new Error("unexpected automatic request");
      return json(resolvedResponse(document, requiredBytes(document)));
    });

    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      readDocument: requiredBytes,
      consumePublished: async (publication) => {
        received.push({
          module: publication.module,
          bundleId: publication.bundleId,
          preparedArtifactHash: publication.identity.preparedArtifactHash,
          resolvedArtifactHash: publication.identity.resolvedArtifactHash,
        });
        return true;
      },
    });

    expect(report.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
    expect(received).toEqual([
      { module: "fuzu", bundleId: catalogId("r"), preparedArtifactHash: sha256("artifact:fuzu"), resolvedArtifactHash: sha256("resolved-artifact:fuzu") },
      { module: "barn", bundleId: catalogId("s"), preparedArtifactHash: sha256("artifact:barn"), resolvedArtifactHash: sha256("resolved-artifact:barn") },
    ]);
    expect(JSON.stringify(report)).not.toContain(catalogId("r"));
    expect(JSON.stringify(report)).not.toContain(catalogId("s"));
  });

  test("rejects a resolved identity mismatch before any opaque bundle handle can reach the host consumer", async () => {
    let consumerCalls = 0;
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) throw new Error("unexpected automatic request");
      const result = resolvedResponse(document, requiredBytes(document));
      result.identity.documentHash = sha256(`foreign-document:${document.id}`);
      return json(result);
    });

    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      readDocument: requiredBytes,
      consumePublished: () => {
        consumerCalls++;
        return true;
      },
    });

    expect(report.modules.map((module) => module.status)).toEqual(["response_refused", "response_refused"]);
    expect(report.modules.map((module) => module.code)).toEqual(["auto_response_invalid", "auto_response_invalid"]);
    expect(consumerCalls).toBe(0);
  });

  test("fails closed on a cross-module resolved bundle collision before either handle is consumed", async () => {
    let consumerCalls = 0;
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) throw new Error("unexpected automatic request");
      const result = resolvedResponse(document, requiredBytes(document));
      result.bundleId = catalogId("r");
      return json(result);
    });

    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      readDocument: requiredBytes,
      consumePublished: () => {
        consumerCalls++;
        return true;
      },
    });

    expect(report.modules.map((module) => module.status)).toEqual(["identity_refused", "identity_refused"]);
    expect(report.modules.map((module) => module.code)).toEqual(["published_identity_not_isolated", "published_identity_not_isolated"]);
    expect(consumerCalls).toBe(0);
  });

  test("contains host consumer rejection and exceptions without claiming a session result", async () => {
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) throw new Error("unexpected automatic request");
      return json(resolvedResponse(document, requiredBytes(document)));
    });

    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      readDocument: requiredBytes,
      consumePublished: (publication) => {
        if (publication.module === "fuzu") return false;
        throw new Error("must not leak through the campaign report");
      },
    });

    expect(report.modules.map((module) => module.status)).toEqual(["published_consumer_refused", "published_consumer_failed"]);
    expect(report.modules.map((module) => module.code)).toEqual(["published_consumer_refused", "published_consumer_failed"]);
    expect(JSON.stringify(report)).not.toContain("must not leak through the campaign report");
  });

  test("treats a runtime-nonboolean host consumer result as refusal rather than truthy consumption", async () => {
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) throw new Error("unexpected automatic request");
      return json(resolvedResponse(document, requiredBytes(document)));
    });

    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      readDocument: requiredBytes,
      consumePublished: () => "truthy-but-not-authorized" as unknown as boolean,
    });

    expect(report.modules.map((module) => module.status)).toEqual(["published_consumer_refused", "published_consumer_refused"]);
  });

  test("awaits the host-owned consumer before returning a consumed report", async () => {
    let releaseConsumer: ((value: boolean) => void) | undefined;
    const consumerRelease = new Promise<boolean>((resolve) => { releaseConsumer = resolve; });
    let enteredConsumer: (() => void) | undefined;
    const consumerEntered = new Promise<void>((resolve) => { enteredConsumer = resolve; });
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) throw new Error("unexpected automatic request");
      return json(resolvedResponse(document, requiredBytes(document)));
    });
    let returned = false;
    const running = runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      readDocument: requiredBytes,
      consumePublished: async () => {
        enteredConsumer?.();
        return await consumerRelease;
      },
    }).then((report) => {
      returned = true;
      return report;
    });

    await consumerEntered;
    expect(returned).toBe(false);
    releaseConsumer?.(true);
    const report = await running;
    expect(report.modules.map((module) => module.status)).toEqual(["published_consumed", "published_consumed"]);
  });

  test("does not begin any HTTP or model workflow until both exact local hashes are authorized", async () => {
    let calls = 0;
    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: [allowedHashes()[0]!],
      readDocument: requiredBytes,
      transport: async () => {
        calls++;
        throw new Error("unauthorized campaign must not transport bytes");
      },
    });

    expect(calls).toBe(0);
    expect(report.modules.map((module) => module.status)).toEqual(["not_authorized", "not_authorized"]);
  });

  test("rejects an automatic response bound to another prepared artifact before it can become a continuation", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      return json({
        status: "draft_only",
        preparedArtifactId: body.preparedArtifactId === preparedId("fuzu") ? preparedId("barn") : preparedId("fuzu"),
        continuationId: catalogId("j"),
        progress: true,
        rounds: [{ callCount: 1 }],
      });
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["response_refused", "response_refused"]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(2);
  });

  test("rejects a missing token and a repeated continuation token without sending another equivalent request", async () => {
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      if (body.preparedArtifactId === preparedId("fuzu")) {
        return json({
          status: "draft_only",
          preparedArtifactId: body.preparedArtifactId,
          continuationId: catalogId("k"),
          progress: true,
          rounds: [{ callCount: 1 }],
        });
      }
      return json({ status: "draft_only", preparedArtifactId: body.preparedArtifactId, progress: true, rounds: [{ callCount: 1 }] });
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["response_refused", "response_refused"]);
    expect(report.modules.map((module) => module.autoResolveAttempts)).toEqual([2, 1]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(3);
  });

  test("rejects an ABA continuation and a token already issued to the other module", async () => {
    let fuzuAttempt = 0;
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      if (body.preparedArtifactId === preparedId("fuzu")) {
        fuzuAttempt++;
        const token = [catalogId("c"), catalogId("d"), catalogId("c")][fuzuAttempt - 1]!;
        return json({ status: "draft_only", preparedArtifactId: body.preparedArtifactId, continuationId: token, progress: true, rounds: [{ callCount: 1 }] });
      }
      return json({ status: "presentation_draft_only", preparedArtifactId: body.preparedArtifactId, continuationId: catalogId("g"), progress: true, mechanics: { readiness: "mechanically_closed" }, rounds: [{ callCount: 1 }] });
    });

    const aba = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });
    expect(aba.modules.map((module) => module.status)).toEqual(["response_refused", "mechanics_closed"]);
    expect(aba.modules[0]!.autoResolveAttempts).toBe(3);

    const issued = catalogId("m");
    const crossModule = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      readDocument: requiredBytes,
      transport: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/compiler/prepare") {
          const document = documents.find((candidate) => candidate.moduleId === url.searchParams.get("moduleId"));
          if (!document) throw new Error("unexpected module");
          return json(preparedResponse(document, requiredBytes(document)), 201);
        }
        const body = await request.json() as { preparedArtifactId: string };
        return json({ status: "presentation_draft_only", preparedArtifactId: body.preparedArtifactId, continuationId: issued, progress: true, mechanics: { readiness: "mechanically_closed" }, rounds: [{ callCount: 1 }] });
      },
    });
    expect(crossModule.modules.map((module) => module.status)).toEqual(["mechanics_closed", "response_refused"]);
  });

  test("recognizes a same-module closed continuation replay as mechanics closed even when it made no new progress", async () => {
    const calls = new Map<string, number>();
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      const document = documents.find((candidate) => body.preparedArtifactId === preparedId(candidate.id));
      if (!document) throw new Error("unexpected prepared artifact");
      const count = calls.get(document.id) ?? 0;
      calls.set(document.id, count + 1);
      const continuationId = catalogId(document.id === "fuzu" ? "c" : "d");
      return count === 0
        ? json({ status: "draft_only", preparedArtifactId: body.preparedArtifactId, continuationId, progress: true, rounds: [{ callCount: 1 }] })
        : json({ status: "presentation_draft_only", preparedArtifactId: body.preparedArtifactId, continuationId, progress: false, mechanics: { readiness: "mechanically_closed" }, rounds: [{ callCount: 0 }] });
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.status)).toEqual(["mechanics_closed", "mechanics_closed"]);
    expect(report.modules.map((module) => module.autoResolveAttempts)).toEqual([2, 2]);
  });

  test("reports malformed round accounting and failed HTTP work as unobservable rather than zero provider calls", async () => {
    const { transport } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      if (body.preparedArtifactId === preparedId("fuzu")) {
        return json({ status: "draft_only", preparedArtifactId: body.preparedArtifactId, progress: false, rounds: [{ callCount: "not-a-number" }] });
      }
      return json({ error: { code: "AUTO_ADMISSION_DEADLINE_EXCEEDED" } }, 503);
    });

    const report = await runTwoModuleHttpCampaign({ documents, allowedDocumentHashes: allowedHashes(), transport, readDocument: requiredBytes });

    expect(report.modules.map((module) => module.reportedProposalCalls)).toEqual(["unobservable", "unobservable"]);
    expect(report.modules.map((module) => module.status)).toEqual(["stopped_no_progress", "response_refused"]);
  });

  test("bounds the HTTP workflow attempts even while the server returns fresh progress continuations", async () => {
    let continuation = 0;
    const { transport, requests } = makeTransport((request) => {
      if (request.pathname === "/api/compiler/prepare") {
        const moduleId = new URL(`http://internal.invalid${request.pathname}${request.query}`).searchParams.get("moduleId");
        const document = documents.find((candidate) => candidate.moduleId === moduleId);
        if (!document || !request.bytes) throw new Error("unexpected prepare request");
        return json(preparedResponse(document, request.bytes), 201);
      }
      const body = request.body as { preparedArtifactId: string };
      continuation++;
      return json({ status: "draft_only", preparedArtifactId: body.preparedArtifactId, continuationId: catalogId(["m", "n", "p", "q"][continuation - 1]!), progress: true, rounds: [{ callCount: 1 }] });
    });

    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      transport,
      readDocument: requiredBytes,
      maxAutoResolveAttemptsPerModule: 2,
    });

    expect(report.modules.map((module) => module.status)).toEqual(["attempt_budget_exhausted", "attempt_budget_exhausted"]);
    expect(report.modules.map((module) => module.autoResolveAttempts)).toEqual([2, 2]);
    expect(requests.filter((request) => request.pathname === "/api/compiler/auto-resolve")).toHaveLength(4);
  });

  test("fails closed without transport when an explicit HTTP-attempt cap is invalid instead of widening it to the default", async () => {
    let calls = 0;
    const report = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      readDocument: requiredBytes,
      maxAutoResolveAttemptsPerModule: 0,
      transport: async () => {
        calls++;
        throw new Error("invalid budget must not invoke transport");
      },
    });

    expect(calls).toBe(0);
    expect(report.modules.map((module) => module.status)).toEqual(["configuration_refused", "configuration_refused"]);
    expect(report.modules.map((module) => module.code)).toEqual(["auto_attempt_budget_invalid", "auto_attempt_budget_invalid"]);
  });

  test("accounts failed transport and JSON-body time while strictly redacting unrecognized error codes", async () => {
    const prepareClock = { now: 0 };
    const prepareFailure = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      readDocument: requiredBytes,
      now: () => prepareClock.now,
      transport: async () => {
        prepareClock.now += 10;
        throw new Error("transport failure must not leak");
      },
    });
    expect(prepareFailure.modules.map((module) => module.timing.prepareElapsedMs)).toEqual([10, 10]);
    expect(prepareFailure.modules.map((module) => module.code)).toEqual(["prepare_transport_failed", "prepare_transport_failed"]);

    const autoClock = { now: 0 };
    const delayedJson = (value: unknown, status: number): Response => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        autoClock.now += 4;
        return value;
      },
    } as unknown as Response);
    const autoFailure = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: allowedHashes(),
      readDocument: requiredBytes,
      now: () => autoClock.now,
      transport: async (request) => {
        autoClock.now += 8;
        const url = new URL(request.url);
        if (url.pathname === "/api/compiler/prepare") {
          const document = documents.find((candidate) => candidate.moduleId === url.searchParams.get("moduleId"));
          if (!document) throw new Error("unexpected module");
          return delayedJson(preparedResponse(document, requiredBytes(document)), 201);
        }
        return delayedJson({ error: { code: "SECRET_CANARY_DO_NOT_RENDER" } }, 503);
      },
    });
    expect(autoFailure.modules.map((module) => module.timing.autoResolveElapsedMs)).toEqual([12, 12]);
    expect(autoFailure.modules.map((module) => module.code)).toEqual(["auto_http_503", "auto_http_503"]);
    expect(JSON.stringify(autoFailure)).not.toContain("SECRET_CANARY_DO_NOT_RENDER");
  });
});
