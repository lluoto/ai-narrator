import { SanityEngine } from "../rules/coc-engine";

/**
 * Package-internal source-fence primitives for an ordinary session's SAN
 * cohort.  Callers provide only authorities they already own; this module
 * neither receives nor returns a GameSession (and is deliberately absent from
 * the public src/index barrel).
 */
export interface SanityCohortPartyMember {
  readonly pcId: string;
  readonly san: SanityEngine;
}

export interface SanityCohortAuthorities {
  readonly sanityEngines: ReadonlyMap<string, SanityEngine>;
  readonly party: Iterable<readonly [string, SanityCohortPartyMember]>;
  readonly activeSanity: SanityEngine;
  readonly activePlayerId: string;
}

export interface CapturedSanityCohortMember {
  readonly pcId: string;
  readonly raw: SanityEngine;
  readonly semanticRevision: bigint;
}

/** Snapshot raw identities and revisions in stable pcId order. */
export function captureSanityCohort(
  sanityEngines: ReadonlyMap<string, SanityEngine>,
): readonly CapturedSanityCohortMember[] {
  return [...sanityEngines.entries()]
    .sort(([leftPcId], [rightPcId]) => leftPcId.localeCompare(rightPcId))
    .map(([pcId, raw]) => ({
      pcId,
      raw,
      semanticRevision: raw.semanticRevision,
    }));
}

/**
 * Compare the captured cohort against caller-owned live authorities.  The
 * checks intentionally preserve the ordinary-session fence's distinctions:
 * map cardinality, raw identity, semantic ABA, party key/member/raw aliases,
 * and the current active raw alias all invalidate; an exact SAN no-op does
 * not.
 */
export function isSanityCohortCurrent(
  captured: readonly CapturedSanityCohortMember[],
  { sanityEngines, party, activeSanity, activePlayerId }: SanityCohortAuthorities,
): boolean {
  if (sanityEngines.size !== captured.length) return false;
  for (const member of captured) {
    const current = sanityEngines.get(member.pcId);
    if (current !== member.raw || current.semanticRevision !== member.semanticRevision) return false;
  }
  for (const [pcId, member] of party) {
    if (member.pcId !== pcId || member.san !== sanityEngines.get(pcId)) return false;
  }
  return activeSanity === sanityEngines.get(activePlayerId);
}
