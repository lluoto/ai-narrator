/**
 * Select the exact persisted score and growth key for first aid. The
 * medicine/localized fallbacks remain for historical in-memory cards, even
 * though the current portable CoC-card validator requires first_aid.
 */
export type FirstAidSkillSource = Readonly<{
  baseScore: number;
  canonicalSkill: "first_aid" | "medicine" | null;
  healing: "first_aid_one" | "medicine_d3";
}>;

export function resolveFirstAidSkillSource(card: Readonly<{
  skillValues?: Readonly<Record<string, number | undefined>>;
  skills?: Readonly<Record<string, number | undefined>>;
}>): FirstAidSkillSource {
  const storedFirstAid = card.skillValues?.first_aid ?? card.skills?.first_aid;
  const storedMedicine = card.skillValues?.medicine ?? card.skills?.medicine;
  return {
    canonicalSkill: storedFirstAid != null ? "first_aid" : storedMedicine != null ? "medicine" : null,
    baseScore: storedFirstAid ?? storedMedicine ?? card.skillValues?.["\u6025\u6551"] ?? card.skills?.["\u6025\u6551"] ?? 30,
    healing: storedFirstAid == null && storedMedicine != null ? "medicine_d3" : "first_aid_one",
  };
}
