import { describe, expect, it } from "bun:test";
import {
  MachinePresentationPublisherError,
  createBoundedCompilerAutoLlm,
  createServerMachinePresentationPublisher,
} from "../api/compiler-machine-presentation-publisher";
import type { MachinePresentationSelectionInput } from "../api/compiled-module-http";
import { sha256 } from "../ingest/document-ir";
import type { LLMLike, Message } from "../llm/client";

type Audience = "public_on_entry" | "found_clue" | "terminal_only" | "private_context";
interface SlotSpec { fieldPath: string; exactText: string; audience: Audience; }

function selectedField(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).fieldPath !== "string") {
    throw new Error("publisher returned a malformed selection");
  }
  return (value as Record<string, unknown>).fieldPath as string;
}

function selectorInput(slots: readonly SlotSpec[], oneSlotPerPage = false): MachinePresentationSelectionInput {
  const candidate = (fieldPath: string) => sha256(`candidate:${fieldPath}`);
  const pages = oneSlotPerPage ? slots.map((slot) => [slot]) : [slots];
  return {
    identity: {
      moduleId: "publisher-test",
      documentHash: null,
      sourceGraphIdentity: sha256("source"),
      preparedQueueHash: sha256("prepared"),
      resolvedQueueHash: sha256("resolved"),
      mechanicsHash: sha256("mechanics"),
    },
    readSlotPage: (offset) => {
      const pageIndex = oneSlotPerPage ? offset : offset === 0 ? 0 : -1;
      const page = pages[pageIndex];
      if (!page) return { status: "refused", code: "PRESENTATION_METADATA_INVALID", message: "unknown page" } as const;
      return {
        status: "selection_slot_paged" as const,
        page: {
          slots: page.map((slot) => ({
            fieldPath: slot.fieldPath,
            allowedBindingKinds: ["source_exact"] as Array<"source_exact">,
            sourceCandidateCount: 1,
            opaqueBinding: null,
            opaqueCandidateDigest: null,
          })),
          hasMore: pageIndex + 1 < pages.length,
        },
        fieldPathOrderHash: sha256("order"),
      };
    },
    readCandidatePage: (fieldPath, offset) => {
      const slot = slots.find((candidateSlot) => candidateSlot.fieldPath === fieldPath);
      if (!slot || offset !== 0) return { status: "refused", code: "PRESENTATION_METADATA_INVALID", message: "unknown candidate" } as const;
      return {
        status: "selection_paged" as const,
        page: {
          fieldPath,
          offset: 0,
          sourceCandidateOrderHash: sha256(`order:${fieldPath}`),
          candidates: [{ kind: "source_exact" as const, candidateDigest: candidate(fieldPath), exactText: slot.exactText, quotePolicy: "exact_nonempty_substring" as const }],
          hasMore: false,
        },
      };
    },
    signal: new AbortController().signal,
  };
}

class SelectingFakeLlm implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options: unknown }> = [];

  async chat(messages: Message[], options?: unknown): Promise<string> {
    this.calls.push({ messages, options });
    const request = JSON.parse(messages[1]?.content ?? "{}") as {
      slots?: Array<{ fieldPath: string; expectedAudience: Audience; candidates: Array<{ candidateDigest: string }> }>;
    };
    if (!request.slots) return "{}";
    return JSON.stringify({
      selections: request.slots.map((slot) => ({
        fieldPath: slot.fieldPath,
        kind: "source_exact",
        candidateDigest: slot.candidates[0]!.candidateDigest,
        audience: slot.expectedAudience,
      })),
    });
  }
}

describe("server machine presentation publisher", () => {
  it("greedily splits a slot page into bounded prompts without dropping canonical coverage", async () => {
    const llm = new SelectingFakeLlm();
    const publisher = createServerMachinePresentationPublisher(llm);
    const result = await publisher.select(selectorInput([
      { fieldPath: "module.title", exactText: "x".repeat(13_000), audience: "public_on_entry" },
      { fieldPath: "module.summary", exactText: "y".repeat(13_000), audience: "public_on_entry" },
    ]));
    expect(llm.calls).toHaveLength(2);
    expect(result.selections.map(selectedField).sort()).toEqual(["module.summary", "module.title"]);
    expect(result.scopes).toEqual([
      { fieldPath: "module.summary", audience: "public_on_entry" },
      { fieldPath: "module.title", audience: "public_on_entry" },
    ]);
  });

  it("rejects an incomplete selector page rather than manufacturing a canonical choice", async () => {
    const llm: LLMLike = {
      chat: async (messages) => {
        const request = JSON.parse(messages[1]?.content ?? "{}") as {
          slots: Array<{ fieldPath: string; candidates: Array<{ candidateDigest: string }>; expectedAudience: Audience }>;
        };
        const first = request.slots[0]!;
        return JSON.stringify({ selections: [{
          fieldPath: first.fieldPath,
          kind: "source_exact",
          candidateDigest: first.candidates[0]!.candidateDigest,
          audience: first.expectedAudience,
        }] });
      },
    };
    let failure: unknown;
    try {
      await createServerMachinePresentationPublisher(llm).select(selectorInput([
        { fieldPath: "module.title", exactText: "title", audience: "public_on_entry" },
        { fieldPath: "module.summary", exactText: "summary", audience: "public_on_entry" },
      ]));
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MachinePresentationPublisherError);
    expect((failure as MachinePresentationPublisherError).code).toBe("selector_response_invalid");
  });

  it("reads every canonical candidate page instead of silently treating the first page as the choice domain", async () => {
    const firstDigest = sha256("candidate:first");
    const secondDigest = sha256("candidate:second");
    let promptCandidateDigests: string[] = [];
    const input: MachinePresentationSelectionInput = {
      identity: {
        moduleId: "publisher-page-coverage",
        documentHash: null,
        sourceGraphIdentity: sha256("source"),
        preparedQueueHash: sha256("prepared"),
        resolvedQueueHash: sha256("resolved"),
        mechanicsHash: sha256("mechanics"),
      },
      readSlotPage: () => ({
        status: "selection_slot_paged",
        page: {
          slots: [{
            fieldPath: "scenes.scene-1.description",
            allowedBindingKinds: ["source_exact"],
            sourceCandidateCount: 2,
            opaqueBinding: null,
            opaqueCandidateDigest: null,
          }],
          hasMore: false,
        },
        fieldPathOrderHash: sha256("one-slot"),
      }),
      readCandidatePage: (_fieldPath, offset) => {
        if (offset === 0) return {
          status: "selection_paged",
          page: {
            fieldPath: "scenes.scene-1.description",
            offset,
            sourceCandidateOrderHash: sha256("order"),
            candidates: [{ kind: "source_exact", candidateDigest: firstDigest, exactText: "first legal source", quotePolicy: "exact_nonempty_substring" }],
            hasMore: true,
          },
        } as const;
        if (offset === 1) return {
          status: "selection_paged",
          page: {
            fieldPath: "scenes.scene-1.description",
            offset,
            sourceCandidateOrderHash: sha256("order"),
            candidates: [{ kind: "source_exact", candidateDigest: secondDigest, exactText: "second legal source", quotePolicy: "exact_nonempty_substring" }],
            hasMore: false,
          },
        } as const;
        return { status: "refused", code: "PRESENTATION_METADATA_INVALID", message: "unexpected candidate offset" } as const;
      },
      signal: new AbortController().signal,
    };
    const llm: LLMLike = {
      chat: async (messages) => {
        const request = JSON.parse(messages[1]?.content ?? "{}") as { slots: Array<{ fieldPath: string; expectedAudience: Audience; candidates: Array<{ candidateDigest: string }> }> };
        const slot = request.slots[0]!;
        promptCandidateDigests = slot.candidates.map((candidate) => candidate.candidateDigest);
        return JSON.stringify({ selections: [{
          fieldPath: slot.fieldPath,
          kind: "source_exact",
          candidateDigest: secondDigest,
          audience: slot.expectedAudience,
        }] });
      },
    };
    const result = await createServerMachinePresentationPublisher(llm).select(input);
    expect(promptCandidateDigests).toEqual([firstDigest, secondDigest]);
    expect(result.selections).toEqual([{
      fieldPath: "scenes.scene-1.description",
      kind: "source_exact",
      candidateDigest: secondDigest,
      offset: 1,
      sourceCandidateOrderHash: sha256("order"),
    }]);
  });

  it("fails closed before a seventeenth selector batch and shares the total dispatch cap", async () => {
    const llm = new SelectingFakeLlm();
    const bounded = createBoundedCompilerAutoLlm(llm);
    for (let call = 0; call < 16; call++) {
      await bounded.llm.chat([{ role: "user", content: `mechanics-${call}` }], { maxAttempts: 1 });
    }
    const publisher = createServerMachinePresentationPublisher(bounded.llm);
    const slots = Array.from({ length: 17 }, (_, index) => ({
      fieldPath: `scenes.scene-${index}.description`,
      exactText: "x".repeat(13_000),
      audience: "public_on_entry" as const,
    }));
    let failure: unknown;
    try { await publisher.select(selectorInput(slots, true)); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MachinePresentationPublisherError);
    expect((failure as MachinePresentationPublisherError).code).toBe("selector_budget_exhausted");
    expect(bounded.dispatched()).toBe(32);
    expect(llm.calls).toHaveLength(32);
    await expect(bounded.llm.chat([{ role: "user", content: "thirty-third dispatch" }], { maxAttempts: 9 }))
      .rejects.toMatchObject({ code: "selector_budget_exhausted" });
    expect(bounded.dispatched()).toBe(32);
    expect(llm.calls).toHaveLength(32);
  });
});
