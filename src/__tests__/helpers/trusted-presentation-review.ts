import {
  buildTrustedPresentationReviewCandidatePage,
  buildTrustedPresentationReviewSlotPage,
  TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE,
  type TrustedPresentationBinding,
} from "../../compiler/compiler-module-data-projection";

/** Defaults module metadata to honest unavailability; callers opt into exact source claims one field at a time. */
export function exactReviewBindings(payload: any): TrustedPresentationBinding[] {
  const slots = [];
  for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE) {
    const page = buildTrustedPresentationReviewSlotPage(payload, offset);
    if (page.status === "refused") throw new Error(page.message);
    slots.push(...page.page.slots);
    if (!page.page.hasMore) break;
  }
  return slots.map((slot) => {
    if (slot.opaqueBinding && slot.fieldPath.startsWith("module.")) return slot.opaqueBinding;
    const page = buildTrustedPresentationReviewCandidatePage(payload, slot.fieldPath, 0);
    if (page.status === "refused") throw new Error(page.message);
    const source = page.page.candidates[0];
    if (!source) throw new Error(`workbench slot lacks an exact source candidate: ${slot.fieldPath}`);
    return source.binding;
  });
}
