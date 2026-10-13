/**
 * Server-owned, bounded machine selector for canonical presentation pages.
 *
 * The model receives source text only in bounded host-private candidate pages.
 * Its response contains digest choices and an untrusted finite audience
 * classification, never quotations, headings, evidence, artifact identity,
 * or a release decision. The HTTP boundary rehydrates the tuples and checks
 * that every classification matches the host's actual consumer policy.
 */
import {
  machinePresentationSelectionCandidatesShareSourceRange,
  trustedPresentationAudienceForFieldPath,
  type UntrustedTrustedPresentationSelection,
} from "../compiler/compiler-module-data-projection";
import { sha256 } from "../ingest/document-ir";
import type { ChatOptions, LLMLike, Message } from "../llm/client";
import { extractJson } from "../llm/json";
import type { MachinePresentationPublisher, MachinePresentationSelectionInput } from "./compiled-module-http";

export const SERVER_MACHINE_PRESENTATION_MAX_SELECTOR_CALLS = 16;
export const SERVER_AUTO_COMPILER_MAX_CHAT_DISPATCHES = 32;
export const SERVER_MACHINE_PRESENTATION_MAX_PROMPT_CHARS = 24_000;
export const SERVER_MACHINE_PRESENTATION_MAX_RESPONSE_CHARS = 96_000;
export const SERVER_MACHINE_PRESENTATION_MAX_RESPONSE_TOKENS = 2_400;

export class MachinePresentationPublisherError extends Error {
  constructor(readonly code: "selector_budget_exhausted" | "selector_prompt_too_large" | "selector_response_invalid" | "selector_response_too_large" | "selector_aborted") {
    super("automatic presentation selection is unavailable");
    this.name = "MachinePresentationPublisherError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

type SelectorAudience = "public_on_entry" | "found_clue" | "terminal_only" | "private_context";

type SelectorPromptSlot = {
  fieldPath: string;
  expectedAudience: SelectorAudience;
  candidates: Array<{ candidateDigest: string; exactText: string; quotePolicy: string }>;
  opaqueCandidateDigest: string | null;
  /** Host-derived digest-only constraint; prior source text is never copied. */
  eligibility: { forbiddenCandidateDigests: string[] };
};

type SelectorPromptSlotBase = Omit<SelectorPromptSlot, "eligibility">;

function publicTerminalSourceConflict(
  left: { audience: SelectorAudience; candidate: unknown },
  right: { audience: SelectorAudience; candidate: unknown },
): boolean {
  return ((left.audience === "public_on_entry" && right.audience === "terminal_only")
    || (left.audience === "terminal_only" && right.audience === "public_on_entry"))
    && machinePresentationSelectionCandidatesShareSourceRange(left.candidate, right.candidate);
}

function selectionPrompt(input: MachinePresentationSelectionInput, slots: readonly SelectorPromptSlot[]): Message[] {
  const request = {
    schemaVersion: "server-machine-presentation-selector-v1",
    resolvedIdentity: input.identity,
    crossSlotConstraint: "Across the complete selection, a public_on_entry source_exact choice must not overlap the same source statement/range selected for a terminal_only endings.* choice. For this request, eligibility.forbiddenCandidateDigests are host-derived choices that must not be selected. The host independently validates this boundary.",
    slots,
  };
  return [
    {
      role: "system",
      content: "你是受限的编译展示选择器。候选 source_exact 文本仅供本次受控评估，不代表可向玩家公开，也不能成为新的模组事实。每个 slot 都有 host 声明的 expectedAudience；你必须依据候选本身报告该候选实际可见性的 untrusted audience（public_on_entry、found_clue、terminal_only 或 private_context）。若无法支持 expectedAudience，报告更严格的实际 audience；host 会拒绝不匹配的选择。对每个 slot 仅从给出的 candidateDigest 选择；不要编写、改写、引用或解释原文。若 slot 有 source_exact 候选，必须选择其中一个 source_exact；只有没有 source_exact 候选的 slot 才可选择其 opaque_unavailable。不要输出 quote、heading、evidence、artifact 身份、权限或任何额外字段。返回严格 JSON：{\"selections\":[{\"fieldPath\":\"...\",\"kind\":\"source_exact|opaque_unavailable\",\"candidateDigest\":\"...\",\"audience\":\"...\"}]}。",
    },
    { role: "user", content: JSON.stringify(request) },
  ];
}

function promptChars(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

type ModelSelection = {
  fieldPath: string;
  kind: "source_exact" | "opaque_unavailable";
  candidateDigest: string;
  audience: "public_on_entry" | "found_clue" | "terminal_only" | "private_context";
};

function parsePageSelections(raw: string, slots: ReadonlyMap<string, {
  candidates: ReadonlyMap<string, { offset: number; sourceCandidateOrderHash: string }>;
  opaqueCandidateDigest: string | null;
  forbiddenCandidateDigests: ReadonlySet<string>;
}>): ModelSelection[] {
  if (raw.length > SERVER_MACHINE_PRESENTATION_MAX_RESPONSE_CHARS) {
    throw new MachinePresentationPublisherError("selector_response_too_large");
  }
  const decoded = extractJson(raw);
  if (!isRecord(decoded) || !exactKeys(decoded, ["selections"]) || !Array.isArray(decoded.selections)
    || decoded.selections.length !== slots.size) {
    throw new MachinePresentationPublisherError("selector_response_invalid");
  }
  const selected: ModelSelection[] = [];
  const seen = new Set<string>();
  for (const value of decoded.selections) {
    if (!isRecord(value) || !exactKeys(value, ["fieldPath", "kind", "candidateDigest", "audience"])
      || typeof value.fieldPath !== "string"
      || (value.kind !== "source_exact" && value.kind !== "opaque_unavailable")
      || typeof value.candidateDigest !== "string"
      || (value.audience !== "public_on_entry" && value.audience !== "found_clue" && value.audience !== "terminal_only" && value.audience !== "private_context")
      || !/^[a-f0-9]{64}$/.test(value.candidateDigest)
      || seen.has(value.fieldPath)) {
      throw new MachinePresentationPublisherError("selector_response_invalid");
    }
    const slot = slots.get(value.fieldPath);
    if (!slot) throw new MachinePresentationPublisherError("selector_response_invalid");
    if (value.kind === "source_exact") {
      if (!slot.candidates.has(value.candidateDigest) || slot.forbiddenCandidateDigests.has(value.candidateDigest)) {
        throw new MachinePresentationPublisherError("selector_response_invalid");
      }
    } else if (slot.candidates.size !== 0 || slot.opaqueCandidateDigest !== value.candidateDigest) {
      // A source candidate always wins over an opaque escape. This avoids a
      // default "unavailable" policy while retaining the existing canonical
      // opaque-only fields when their plan explicitly permits them.
      throw new MachinePresentationPublisherError("selector_response_invalid");
    }
    seen.add(value.fieldPath);
    selected.push({ fieldPath: value.fieldPath, kind: value.kind, candidateDigest: value.candidateDigest, audience: value.audience });
  }
  return selected;
}

/**
 * One job-local cap shared by mechanics proposals and this selector. The
 * increment happens before `chat`, so concurrent calls cannot pass the cap
 * merely because an earlier provider promise has not settled yet.
 */
export function createBoundedCompilerAutoLlm(llm: LLMLike, maxDispatches = SERVER_AUTO_COMPILER_MAX_CHAT_DISPATCHES): {
  llm: LLMLike;
  dispatched(): number;
} {
  let dispatches = 0;
  const bounded: LLMLike = {
    chat: async (messages, options) => {
      if (options?.signal?.aborted) throw new MachinePresentationPublisherError("selector_aborted");
      if (!Number.isSafeInteger(maxDispatches) || maxDispatches < 1 || dispatches >= maxDispatches) {
        throw new MachinePresentationPublisherError("selector_budget_exhausted");
      }
      dispatches++;
      const boundedOptions: ChatOptions = { ...options, maxAttempts: 1 };
      return llm.chat(messages, boundedOptions);
    },
  };
  return { llm: bounded, dispatched: () => dispatches };
}

/**
 * The selector reads every bounded canonical candidate page for a slot before
 * sending that slot. It never turns pagination into a first-page or
 * first-candidate policy: an oversized complete choice domain fails closed,
 * and canonical rehydration remains final.
 */
export function createServerMachinePresentationPublisher(llm: LLMLike): MachinePresentationPublisher {
  return {
    servicePrincipalId: "service:server-machine-presentation",
    policyId: "server-machine-presentation-v1",
    select: async (input) => {
      const selections: UntrustedTrustedPresentationSelection[] = [];
      const selectedAudiences = new Map<string, "public_on_entry" | "found_clue" | "terminal_only" | "private_context">();
      const selectedCanonicalCandidates: Array<{ audience: SelectorAudience; candidate: unknown }> = [];
      const requestHashes: string[] = [];
      const responseHashes: string[] = [];
      let offset = 0;
      let selectorCalls = 0;
      for (;;) {
        if (input.signal.aborted) throw new MachinePresentationPublisherError("selector_aborted");
        const slotPage = input.readSlotPage(offset);
        if (slotPage.status !== "selection_slot_paged" || slotPage.page.slots.length === 0) {
          throw new MachinePresentationPublisherError("selector_response_invalid");
        }
        const pageSlots = new Map<string, {
          candidates: Map<string, { offset: number; sourceCandidateOrderHash: string; canonicalCandidate: unknown }>;
          opaqueCandidateDigest: string | null;
          expectedAudience: SelectorAudience;
        }>();
        const promptSlots: SelectorPromptSlotBase[] = [];
        for (const slot of slotPage.page.slots) {
          const candidates = new Map<string, { offset: number; sourceCandidateOrderHash: string; canonicalCandidate: unknown }>();
          const promptCandidates: Array<{ candidateDigest: string; exactText: string; quotePolicy: string }> = [];
          if (slot.sourceCandidateCount > 0) {
            for (let candidateOffset = 0; ; ) {
              const candidatePage = input.readCandidatePage(slot.fieldPath, candidateOffset);
              if (candidatePage.status !== "selection_paged"
                || candidatePage.page.fieldPath !== slot.fieldPath
                || candidatePage.page.offset !== candidateOffset
                || candidatePage.page.candidates.length === 0) {
                throw new MachinePresentationPublisherError("selector_response_invalid");
              }
              for (const candidate of candidatePage.page.candidates) {
                if (candidates.has(candidate.candidateDigest)) throw new MachinePresentationPublisherError("selector_response_invalid");
                candidates.set(candidate.candidateDigest, {
                  offset: candidatePage.page.offset,
                  sourceCandidateOrderHash: candidatePage.page.sourceCandidateOrderHash,
                  canonicalCandidate: candidate,
                });
                promptCandidates.push({
                  candidateDigest: candidate.candidateDigest,
                  exactText: candidate.exactText,
                  quotePolicy: candidate.quotePolicy,
                });
              }
              if (!candidatePage.page.hasMore) break;
              candidateOffset += candidatePage.page.candidates.length;
            }
          }
          const expectedAudience = trustedPresentationAudienceForFieldPath(slot.fieldPath);
          if (!expectedAudience) throw new MachinePresentationPublisherError("selector_response_invalid");
          pageSlots.set(slot.fieldPath, { candidates, opaqueCandidateDigest: slot.opaqueCandidateDigest, expectedAudience });
          promptSlots.push({ fieldPath: slot.fieldPath, expectedAudience, candidates: promptCandidates, opaqueCandidateDigest: slot.opaqueCandidateDigest });
        }
        const promptSlotWithEligibility = (slot: SelectorPromptSlotBase): SelectorPromptSlot => {
          const pageSlot = pageSlots.get(slot.fieldPath);
          if (!pageSlot) throw new MachinePresentationPublisherError("selector_response_invalid");
          const forbiddenCandidateDigests = slot.candidates
            .filter((candidate) => {
              const canonicalCandidate = pageSlot.candidates.get(candidate.candidateDigest)?.canonicalCandidate;
              if (!canonicalCandidate) throw new MachinePresentationPublisherError("selector_response_invalid");
              return selectedCanonicalCandidates.some((selected) => publicTerminalSourceConflict(
                { audience: slot.expectedAudience, candidate: canonicalCandidate },
                selected,
              ));
            })
            .map((candidate) => candidate.candidateDigest);
          return { ...slot, eligibility: { forbiddenCandidateDigests } };
        };
        const dispatchBatch = async (batchSlots: readonly SelectorPromptSlot[]) => {
          if (input.signal.aborted) throw new MachinePresentationPublisherError("selector_aborted");
          if (selectorCalls >= SERVER_MACHINE_PRESENTATION_MAX_SELECTOR_CALLS) {
            throw new MachinePresentationPublisherError("selector_budget_exhausted");
          }
          selectorCalls++;
          const messages = selectionPrompt(input, batchSlots);
          const options: ChatOptions = {
            jsonMode: true,
            temperature: 0,
            maxTokens: SERVER_MACHINE_PRESENTATION_MAX_RESPONSE_TOKENS,
            maxAttempts: 1,
            signal: input.signal,
          };
          const requestHash = sha256(JSON.stringify({ domain: "server-machine-presentation-selector-v1", messages, options: { jsonMode: true, temperature: 0, maxTokens: options.maxTokens, maxAttempts: options.maxAttempts } }));
          const response = await llm.chat(messages, options);
          const batchMap = new Map(batchSlots.map((slot) => {
            const pageSlot = pageSlots.get(slot.fieldPath);
            if (!pageSlot) throw new MachinePresentationPublisherError("selector_response_invalid");
            return [slot.fieldPath, {
              candidates: pageSlot.candidates,
              opaqueCandidateDigest: pageSlot.opaqueCandidateDigest,
              forbiddenCandidateDigests: new Set(slot.eligibility.forbiddenCandidateDigests),
            }];
          }));
          const choices = parsePageSelections(response, batchMap);
          const currentBatch = choices.flatMap((choice) => {
            if (choice.kind !== "source_exact") return [];
            const slot = pageSlots.get(choice.fieldPath);
            const candidate = slot?.candidates.get(choice.candidateDigest);
            if (!slot || !candidate) throw new MachinePresentationPublisherError("selector_response_invalid");
            return [{ audience: slot.expectedAudience, candidate: candidate.canonicalCandidate }];
          });
          for (let index = 0; index < currentBatch.length; index++) {
            if (currentBatch.slice(index + 1).some((other) => publicTerminalSourceConflict(currentBatch[index]!, other))) {
              // The model selected an internally conflicting pair in this one
              // response. Refuse instead of assigning a page-order winner or
              // spending another selector dispatch to negotiate a replacement.
              throw new MachinePresentationPublisherError("selector_response_invalid");
            }
          }
          requestHashes.push(requestHash);
          responseHashes.push(sha256(response));
          for (const choice of choices) {
            selectedAudiences.set(choice.fieldPath, choice.audience);
            const slot = pageSlots.get(choice.fieldPath)!;
            if (choice.kind === "source_exact") {
              const candidate = slot.candidates.get(choice.candidateDigest)!;
              selectedCanonicalCandidates.push({ audience: slot.expectedAudience, candidate: candidate.canonicalCandidate });
              selections.push({
                fieldPath: choice.fieldPath,
                kind: "source_exact",
                candidateDigest: choice.candidateDigest,
                offset: candidate.offset,
                sourceCandidateOrderHash: candidate.sourceCandidateOrderHash,
              });
            } else {
              selections.push({ fieldPath: choice.fieldPath, kind: "opaque_unavailable", candidateDigest: choice.candidateDigest });
            }
          }
        };
        for (let promptOffset = 0; promptOffset < promptSlots.length; ) {
          const batch: SelectorPromptSlot[] = [];
          for (; promptOffset < promptSlots.length; ) {
            const nextSlot = promptSlotWithEligibility(promptSlots[promptOffset]!);
            const next = [...batch, nextSlot];
            if (promptChars(selectionPrompt(input, next)) <= SERVER_MACHINE_PRESENTATION_MAX_PROMPT_CHARS) {
              batch.push(nextSlot);
              promptOffset++;
              continue;
            }
            if (batch.length === 0) throw new MachinePresentationPublisherError("selector_prompt_too_large");
            break;
          }
          await dispatchBatch(batch);
        }
        if (!slotPage.page.hasMore) break;
        offset += slotPage.page.slots.length;
      }
        const scopes = [...selections]
          .sort((left, right) => left.fieldPath.localeCompare(right.fieldPath))
          .map((selection) => {
            const audience = selectedAudiences.get(selection.fieldPath);
            if (!audience) throw new MachinePresentationPublisherError("selector_response_invalid");
            return { fieldPath: selection.fieldPath, audience };
          });
      return {
        selections,
        scopes,
        requestHash: sha256(JSON.stringify(requestHashes)),
        responseHash: sha256(JSON.stringify(responseHashes)),
      };
    },
  };
}
